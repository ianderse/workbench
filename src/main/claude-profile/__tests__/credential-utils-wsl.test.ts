/**
 * Credentials of a config dir in WSL's Linux home (\\wsl.localhost\<distro>\home\<user>\...):
 * Claude Code inside WSL keeps the sign-in in the dir's .credentials.json only, so
 * - reading it never runs PowerShell (Credential Manager) or any other process
 * - a token refresh rewrites the file in place (keeping its Linux mode), keeps its other entries,
 *   and runs neither PowerShell nor icacls
 * - a native Windows dir still checks the Credential Manager
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, string>());
const fsCalls = vi.hoisted(() => ({ opened: [] as Array<{ path: string; flags: string }>, renamed: 0, created: [] as string[] }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const fds = new Map<number, string>();
  let nextFd = 100;
  const mocked = {
    ...actual,
    // Windows PowerShell is installed (for the native dir)
    existsSync: (p: string) => files.has(p) || /powershell\.exe$/i.test(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return files.get(p);
    },
    openSync: (p: string, flags: string) => {
      fsCalls.opened.push({ path: p, flags });
      const fd = nextFd++;
      fds.set(fd, p);
      return fd;
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const p = fds.get(fd)!;
      const current = Buffer.from(files.get(p) ?? '', 'utf-8');
      const next = Buffer.alloc(Math.max(current.length, position + length));
      current.copy(next);
      buffer.copy(next, position, offset, offset + length);
      files.set(p, next.toString('utf-8'));
      return length;
    },
    ftruncateSync: (fd: number, length: number) => {
      const p = fds.get(fd)!;
      files.set(p, Buffer.from(files.get(p) ?? '', 'utf-8').subarray(0, length).toString('utf-8'));
    },
    closeSync: (fd: number) => {
      fds.delete(fd);
    },
    writeFileSync: (p: string, data: string | Buffer) => {
      fsCalls.created.push(p);
      files.set(p, data.toString());
    },
    mkdirSync: () => undefined,
    renameSync: () => {
      fsCalls.renamed++;
    },
    unlinkSync: () => undefined,
  };
  return { ...mocked, default: mocked };
});
const child = vi.hoisted(() => ({
  execFileSync: vi.fn(() => ''),
  execFile: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: child.execFileSync, execFile: child.execFile };
});
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
}));
vi.mock('../../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/shell-runtime')>()),
  isWslRuntime: () => true,
  getWslInfo: () => ({ distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/', loginPath: '/usr/bin', tools: {} }),
}));

import {
  clearKeychainCache,
  credentialBackendFor,
  getCredentialsFromKeychain,
  getFullCredentialsFromKeychain,
  updateKeychainCredentials,
} from '../credential-utils';

const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';
const WORK_CREDENTIALS = `${HOME}\\.claude-work\\.credentials.json`;
const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40);

beforeEach(() => {
  files.clear();
  fsCalls.opened = [];
  fsCalls.renamed = 0;
  fsCalls.created = [];
  child.execFileSync.mockClear();
  child.execFile.mockClear();
  clearKeychainCache();
});

describe('credentials of config dirs in WSL', () => {
  it('uses the file-only backend for dirs in the Linux home', () => {
    expect(credentialBackendFor(`${HOME}\\.claude-work`)).toBe('wsl-file');
    expect(credentialBackendFor('~/.claude')).toBe('wsl-file');
    expect(credentialBackendFor()).toBe('wsl-file');
    expect(credentialBackendFor('C:\\Users\\me\\.claude')).toBe('platform');
  });

  it('reads .credentials.json without running PowerShell', () => {
    files.set(WORK_CREDENTIALS, JSON.stringify({
      claudeAiOauth: { accessToken: TOKEN, refreshToken: 'rt', expiresAt: 123, subscriptionType: 'max', rateLimitTier: 'tier' },
    }));

    expect(getCredentialsFromKeychain(`${HOME}\\.claude-work`).token).toBe(TOKEN);
    expect(getFullCredentialsFromKeychain(`${HOME}\\.claude-work`)).toMatchObject({ token: TOKEN, refreshToken: 'rt', subscriptionType: 'max' });
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(child.execFile).not.toHaveBeenCalled();
  });

  it('a dir without credentials is not signed in, still without PowerShell', () => {
    expect(getCredentialsFromKeychain(`${HOME}\\.claude-empty`).token).toBeNull();
    expect(child.execFileSync).not.toHaveBeenCalled();
  });

  it('writes refreshed tokens in place, keeping the other entries, without PowerShell or icacls', () => {
    files.set(WORK_CREDENTIALS, JSON.stringify({
      claudeAiOauth: { accessToken: 'old-token-that-is-much-longer-than-the-new-one-' + 'x'.repeat(80), refreshToken: 'old', expiresAt: 1, subscriptionType: 'max' },
      mcpOAuth: { server: { accessToken: 'mcp' } },
    }));

    const result = updateKeychainCredentials(`${HOME}\\.claude-work`, { accessToken: TOKEN, refreshToken: 'new', expiresAt: 999 });

    expect(result).toEqual({ success: true });
    expect(fsCalls.opened).toEqual([{ path: WORK_CREDENTIALS, flags: 'r+' }]);
    expect(fsCalls.renamed).toBe(0);
    expect(fsCalls.created).toEqual([]);
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(child.execFile).not.toHaveBeenCalled();
    const written = JSON.parse(files.get(WORK_CREDENTIALS)!);
    expect(written.claudeAiOauth).toMatchObject({ accessToken: TOKEN, refreshToken: 'new', expiresAt: 999, subscriptionType: 'max' });
    expect(written.mcpOAuth).toEqual({ server: { accessToken: 'mcp' } });
    // The new values are read back (the cache was cleared)
    expect(getCredentialsFromKeychain(`${HOME}\\.claude-work`).token).toBe(TOKEN);
  });

  it('restricts a credentials file it had to create to its owner inside WSL', () => {
    const result = updateKeychainCredentials(`${HOME}\\.claude-new`, { accessToken: TOKEN, refreshToken: 'new', expiresAt: 999 });

    expect(result).toEqual({ success: true });
    expect(fsCalls.created).toEqual([`${HOME}\\.claude-new\\.credentials.json`]);
    expect(child.execFileSync).not.toHaveBeenCalled();
    expect(child.execFile).toHaveBeenCalledWith(
      expect.stringMatching(/wsl(\.exe)?$/i),
      ['-d', 'Ubuntu', '--exec', 'chmod', '600', '/home/me/.claude-new/.credentials.json'],
      expect.anything(),
      expect.any(Function)
    );
  });

  it('a native Windows dir still checks the Credential Manager', () => {
    getCredentialsFromKeychain('C:\\Users\\me\\.claude-work');
    expect(child.execFileSync).toHaveBeenCalled();
  });
});
