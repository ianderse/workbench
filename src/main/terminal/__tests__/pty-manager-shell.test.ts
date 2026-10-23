/**
 * The shell an agent window starts: PowerShell on Windows (PowerShell 7 preferred, Windows
 * PowerShell 5.1 as the fallback), whatever the hidden preferredTerminal setting says, and the
 * user's login shell elsewhere
 */
import os from 'os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';

const mocks = vi.hoisted(() => ({
  isWindows: true,
  wslInfo: null as null | Record<string, unknown>,
  existing: new Set<string>(),
  spawn: vi.fn(() => ({ pid: 1 })),
}));

vi.mock('@lydell/node-pty', () => ({ spawn: mocks.spawn }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: (file: string) => mocks.existing.has(String(file)) };
});
vi.mock('../../platform', () => ({
  isWindows: () => mocks.isWindows,
  getPathDelimiter: () => (mocks.isWindows ? ';' : ':'),
  getWindowsShellPaths: () => (mocks.isWindows ? { powershell: [PWSH7, WINDOWS_POWERSHELL] } : {}),
}));
vi.mock('../../platform/shell-runtime', async () => {
  const { windowsToWsl } = await vi.importActual<typeof import('../../platform/wsl-paths')>('../../platform/wsl-paths');
  return {
    isWslRuntime: () => mocks.wslInfo !== null,
    getWslInfo: () => mocks.wslInfo,
    toRuntimePath: (p: string) => (mocks.wslInfo ? windowsToWsl(p, mocks.wslInfo as { distro: string }) ?? p : p),
  };
});
vi.mock('../../platform/wsl-detect', () => ({ getWslExePath: () => WSL_EXE }));
vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: vi.fn() }));
vi.mock('../../env-utils', () => ({ getSpawnCommand: (c: string) => c, shouldUseShell: () => false }));
vi.mock('../../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));
vi.mock('../../claude-profile/config-dir-paths', () => ({
  withClaudeConfigDir: (env: Record<string, string>) => env,
}));
vi.mock('../../live-agent/terminal-activity', () => ({ noteTerminalWrite: vi.fn() }));
// The hidden preferredTerminal setting must not pick the agent window shell any more
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => ({ preferredTerminal: 'cmd' }) }));

import { detectWindowsShellKind, findWindowsPowerShell, spawnPtyProcess } from '../pty-manager';

const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;

beforeEach(() => {
  mocks.isWindows = true;
  mocks.wslInfo = null;
  mocks.existing = new Set();
  mocks.spawn.mockClear();
  process.env.PATH = originalPath;
  process.env.SHELL = originalShell;
});

describe('detectWindowsShellKind', () => {
  it('gives PowerShell 7 and Windows PowerShell 5.1 the PowerShell syntax', () => {
    expect(detectWindowsShellKind(PWSH7)).toBe('powershell');
    expect(detectWindowsShellKind(WINDOWS_POWERSHELL)).toBe('powershell');
    expect(detectWindowsShellKind('powershell.exe')).toBe('powershell');
  });

  it('keeps cmd.exe syntax for cmd.exe and POSIX syntax for bash', () => {
    expect(detectWindowsShellKind('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(detectWindowsShellKind('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('posix');
  });
});

describe('findWindowsPowerShell', () => {
  it('prefers PowerShell 7 in Program Files', () => {
    mocks.existing = new Set([PWSH7, WINDOWS_POWERSHELL]);
    expect(findWindowsPowerShell()).toBe(PWSH7);
  });

  it('finds PowerShell 7 on PATH when it is installed elsewhere', () => {
    const scoop = 'C:\\Users\\me\\scoop\\shims';
    process.env.PATH = `C:\\Windows\\System32;${scoop}`;
    mocks.existing = new Set([`${scoop}\\pwsh.exe`, WINDOWS_POWERSHELL]);
    expect(findWindowsPowerShell()).toBe(`${scoop}\\pwsh.exe`);
  });

  it('falls back to Windows PowerShell 5.1', () => {
    process.env.PATH = 'C:\\Windows\\System32';
    mocks.existing = new Set([WINDOWS_POWERSHELL]);
    expect(findWindowsPowerShell()).toBe(WINDOWS_POWERSHELL);
  });

  it('falls back to powershell.exe by name when no path is found', () => {
    process.env.PATH = '';
    expect(findWindowsPowerShell()).toBe('powershell.exe');
  });
});

describe('spawnPtyProcess', () => {
  it('starts PowerShell 7 without its logo on Windows, whatever preferredTerminal says', () => {
    mocks.existing = new Set([PWSH7, WINDOWS_POWERSHELL]);
    const { shellKind } = spawnPtyProcess('C:\\repo', 80, 24);

    expect(shellKind).toBe('powershell');
    expect(mocks.spawn).toHaveBeenCalledWith(PWSH7, ['-NoLogo'], expect.objectContaining({ cwd: 'C:\\repo' }));
  });

  it('starts Windows PowerShell 5.1 when PowerShell 7 is not installed', () => {
    process.env.PATH = 'C:\\Windows\\System32';
    mocks.existing = new Set([WINDOWS_POWERSHELL]);
    const { shellKind } = spawnPtyProcess('C:\\repo', 80, 24);

    expect(shellKind).toBe('powershell');
    expect(mocks.spawn).toHaveBeenCalledWith(WINDOWS_POWERSHELL, ['-NoLogo'], expect.anything());
  });

  describe('in the WSL runtime', () => {
    const WSL_INFO = {
      distro: 'Ubuntu',
      user: 'me',
      home: '/home/me',
      loginShell: '/usr/bin/fish',
      loginPath: '/usr/bin:/bin',
      mountRoot: '/mnt/',
      networkingMode: 'nat',
      tools: {},
    };

    it("starts the login shell inside WSL in the window's directory, with the window's variables in WSLENV", () => {
      mocks.wslInfo = WSL_INFO;
      mocks.existing = new Set([PWSH7]);
      const result = spawnPtyProcess('C:\\Users\\me\\my repo', 100, 30, {
        CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-work',
        WORKBENCH_TERMINAL_ID: 'term-1',
      });

      expect(result.shellKind).toBe('posix');
      expect(result.wrapInBash).toBe(true);
      const [file, args, options] = mocks.spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { cwd: string; cols: number; rows: number; env: Record<string, string> },
      ];
      expect(file).toBe(WSL_EXE);
      expect(args).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/Users/me/my repo']);
      expect(options.cwd).toBe(os.homedir());
      expect(options).toMatchObject({ cols: 100, rows: 30 });
      expect(options.env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-work');
      const listed = options.env.WSLENV.split(':');
      expect(listed).toEqual(
        expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'WORKBENCH_TERMINAL_ID', 'TERM', 'COLORTERM'])
      );
      expect(listed).not.toContain('PATH');
      expect(listed).not.toContain('WB_PATH');
    });

    it('types POSIX lines straight into a POSIX login shell', () => {
      mocks.wslInfo = { ...WSL_INFO, loginShell: '/bin/bash' };
      const result = spawnPtyProcess('C:\\repo', 80, 24);
      expect(result.shellKind).toBe('posix');
      expect(result.wrapInBash).toBeUndefined();
      expect((mocks.spawn.mock.calls[0] as unknown[])[1]).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/repo']);
    });
  });

  it("starts the user's login shell elsewhere", () => {
    mocks.isWindows = false;
    process.env.SHELL = '/bin/bash';
    const { shellKind } = spawnPtyProcess('/repo', 80, 24);

    expect(shellKind).toBe('posix');
    expect(mocks.spawn).toHaveBeenCalledWith('/bin/bash', ['-l'], expect.objectContaining({ cwd: '/repo' }));
  });
});
