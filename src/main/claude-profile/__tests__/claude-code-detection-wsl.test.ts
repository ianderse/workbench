/**
 * Claude Code setups when the app runs its tools in WSL: Claude Code keeps its config in the
 * distribution's Linux home, which Windows reaches as \\wsl.localhost\<distro>\home\<user>
 * - the default dir, its ~/.claude.json and the ~/.claude-* dirs come from the UNC home
 * - the managed settings are the distribution's /etc/claude-code/managed-settings.json
 * - the app's own (Windows) environment doesn't make a setup; a passed environment still does
 * - config dir paths (default dir, global config) answer with UNC paths
 *
 * The file system is a map of UNC paths (the tests run on Linux, where UNC paths don't exist).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const files = vi.hoisted(() => new Map<string, string>());
const dirs = vi.hoisted(() => new Set<string>());

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = (p: string) => files.has(p) || dirs.has(p);
  const readFileSync = (p: string) => {
    if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return files.get(p);
  };
  const readdirSync = (p: string) => {
    if (!dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    const prefix = `${p}\\`;
    const names = new Set<string>();
    for (const entry of [...files.keys(), ...dirs]) {
      if (entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split('\\')[0]);
    }
    return [...names].map((name) => ({ name, isDirectory: () => dirs.has(prefix + name) }));
  };
  const mocked = { ...actual, existsSync, readFileSync, readdirSync };
  return { ...mocked, default: mocked };
});
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => true,
  isMacOS: () => false,
  isLinux: () => false,
}));
const wslRef = vi.hoisted(() => ({ on: true }));
vi.mock('../../platform/shell-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/shell-runtime')>();
  const { windowsToWsl, wslToWindows } = await import('../../platform/wsl-paths');
  const info = { distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/', loginPath: '/usr/bin', tools: {} };
  return {
    ...actual,
    isWslRuntime: () => wslRef.on,
    getWslInfo: () => (wslRef.on ? info : null),
    toHostPath: (p: string) => (wslRef.on ? wslToWindows(p, info) : p),
    toRuntimePath: (p: string) => (wslRef.on ? windowsToWsl(p, info) ?? p : p),
  };
});

import { detectClaudeCodeSetups, detectedAccountName } from '../claude-code-detection';
import { getClaudeGlobalConfigPath, getDefaultClaudeConfigDir, isDefaultClaudeConfigDir } from '../config-dir-paths';
import { getClaudeHome, getClaudeManagedSettingsPath } from '../../platform/claude-home';

const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';
const write = (file: string, data: unknown) => files.set(file, JSON.stringify(data));

beforeEach(() => {
  wslRef.on = true;
  files.clear();
  dirs.clear();
  dirs.add(HOME);
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('Claude Code setups in WSL', () => {
  it("answers with the Linux home's UNC paths", () => {
    expect(getClaudeHome()).toBe(HOME);
    expect(getDefaultClaudeConfigDir()).toBe(`${HOME}\\.claude`);
    expect(isDefaultClaudeConfigDir('~/.claude')).toBe(true);
    expect(getClaudeGlobalConfigPath(`${HOME}\\.claude`)).toBe(`${HOME}\\.claude.json`);
    expect(getClaudeGlobalConfigPath(`${HOME}\\.claude-work`)).toBe(`${HOME}\\.claude-work\\.claude.json`);
    expect(getClaudeManagedSettingsPath()).toBe('\\\\wsl.localhost\\Ubuntu\\etc\\claude-code\\managed-settings.json');
  });

  it('finds the default dir and the ~/.claude-* dirs of the Linux home', () => {
    dirs.add(`${HOME}\\.claude`);
    dirs.add(`${HOME}\\.claude-work`);
    dirs.add(`${HOME}\\.claude-access`);
    write(`${HOME}\\.claude.json`, { oauthAccount: { emailAddress: 'me@example.com', organizationType: 'claude_max' } });
    write(`${HOME}\\.claude-work\\settings.json`, { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } });

    const setups = detectClaudeCodeSetups({
      hasSubscriptionCredentials: (dir) => dir === `${HOME}\\.claude`,
    });

    expect(setups.map((setup) => setup.configDir)).toEqual([`${HOME}\\.claude`, `${HOME}\\.claude-work`]);
    expect(setups[0]).toMatchObject({ provider: 'subscription', isDefaultDir: true, email: 'me@example.com', plan: 'max' });
    // Shown as Claude Code names them in the distribution, not by their UNC paths
    expect(setups[0].credentials).toBe('~/.claude/.credentials.json');
    expect(setups[1].values.find((value) => value.key === 'AWS_REGION')?.source).toBe('/home/me/.claude-work/settings.json');
    expect(setups[1]).toMatchObject({ provider: 'bedrock', isDefaultDir: false });
    expect(detectedAccountName(setups[1])).toBe('Claude Code (work)');
  });

  it("reads the distribution's managed settings", () => {
    dirs.add(`${HOME}\\.claude`);
    write('\\\\wsl.localhost\\Ubuntu\\etc\\claude-code\\managed-settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'gateway-token-123456' } });

    const [setup] = detectClaudeCodeSetups({ hasSubscriptionCredentials: () => false });
    expect(setup).toMatchObject({ provider: 'auth-token', isDefaultDir: true });
    expect(setup.credentials).toBe('/etc/claude-code/managed-settings.json');
  });

  it("doesn't take the app's Windows environment for Claude Code's, but a passed one counts", () => {
    dirs.add(`${HOME}\\.claude`);
    process.env.ANTHROPIC_API_KEY = 'sk-windows-shell';

    expect(detectClaudeCodeSetups({ hasSubscriptionCredentials: () => false })).toEqual([]);

    const [setup] = detectClaudeCodeSetups({
      env: { ANTHROPIC_API_KEY: 'sk-linux-env-123456', CLAUDE_CONFIG_DIR: '/home/me/.claude-env' },
      hasSubscriptionCredentials: () => false,
    });
    expect(setup).toMatchObject({ provider: 'api-key', credentials: 'environment' });
  });

  it("leaves out the app's own ~/.claude-profiles dirs", () => {
    dirs.add(`${HOME}\\.claude-profiles`);
    write(`${HOME}\\.claude-profiles\\settings.json`, { env: { CLAUDE_CODE_USE_VERTEX: '1' } });

    const setups = detectClaudeCodeSetups({
      excludeUnder: [`${HOME}\\.claude-profiles`],
      hasSubscriptionCredentials: () => false,
    });
    expect(setups).toEqual([]);
  });
});
