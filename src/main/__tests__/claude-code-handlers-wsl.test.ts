/**
 * Claude Code handlers and the WSL runtime:
 * - setting the active Claude CLI keeps every other tool path (the cache used to be reconfigured
 *   with the Claude path only, which dropped the others, WSL paths included)
 * - in WSL the active path is a Linux path, saved as wslToolPaths.claude and checked inside WSL
 * - a WSL console opens as a Windows Terminal tab (`;` escaped for wt.exe) or a `start`ed console
 *   window, running bash directly
 * - the installer is the Linux one, run in a WSL console
 * - installations are looked up inside WSL
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)) },
}));

const tools = vi.hoisted(() => ({
  configureTools: vi.fn(),
  getToolInfo: vi.fn(),
}));
vi.mock('../cli-tool-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli-tool-manager')>();
  return {
    isWslToolPath: actual.isWslToolPath,
    getToolInfoAsync: async (...args: unknown[]) => tools.getToolInfo(...args),
    configureTools: tools.configureTools,
    getClaudeDetectionPaths: () => ({ homebrewPaths: [], platformPaths: [], nvmVersionsDir: '' }),
    sortNvmVersionDirs: () => [],
  };
});

const settingsRef = vi.hoisted(() => ({ current: {} as Record<string, unknown>, written: [] as Record<string, unknown>[] }));
vi.mock('../settings-utils', () => ({
  readSettingsFile: () => settingsRef.current,
  writeSettingsFile: (settings: Record<string, unknown>) => {
    settingsRef.written.push(settings);
    settingsRef.current = settings;
  },
}));
vi.mock('../utils/windows-paths', () => ({
  isSecurePath: () => true,
  getWhereExePath: () => 'where.exe',
  getTaskkillExePath: () => 'taskkill.exe',
}));
vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: () => ({}) }));

const fsRef = vi.hoisted(() => ({ windowsTerminal: true }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: () => true,
    lstatSync: (p: string) => {
      if (fsRef.windowsTerminal && /wt\.exe$/i.test(p)) return {};
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
  return { ...mocked, default: mocked };
});

const proc = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn(), removeListener: vi.fn() })),
  execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    callback(null, { stdout: '2.1.0 (Claude Code)\n', stderr: '' });
  }),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: proc.spawn, execFile: proc.execFile, execFileSync: vi.fn() };
});

const wslRef = vi.hoisted(() => ({ on: false }));
const WSL_INFO = vi.hoisted(() => ({
  distro: 'Ubuntu',
  user: 'me',
  home: '/home/me',
  loginShell: '/bin/bash',
  loginPath: '/home/me/.local/bin:/usr/bin',
  mountRoot: '/mnt/',
  networkingMode: 'nat',
  tools: { claude: { path: '/home/me/.local/bin/claude', version: '2.1.0' } },
}));
vi.mock('../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/shell-runtime')>()),
  isWslRuntime: () => wslRef.on,
  getWslInfo: () => (wslRef.on ? WSL_INFO : null),
}));
vi.mock('../platform/wsl-detect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/wsl-detect')>()),
  getWslExePath: () => 'C:\\Windows\\System32\\wsl.exe',
}));
const runtime = vi.hoisted(() => ({
  runTool: vi.fn(async () => ({ stdout: '2.1.307 (Claude Code)\n', stderr: '' })),
}));
vi.mock('../platform/runtime-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/runtime-exec')>()),
  runTool: runtime.runTool,
}));
const wslExec = vi.hoisted(() => ({ execInWsl: vi.fn() }));
vi.mock('../platform/wsl-exec-basic', () => ({ execInWsl: wslExec.execInWsl }));

import { IPC_CHANNELS } from '../../shared/constants';
import { buildWslConsoleLaunch, registerClaudeCodeHandlers } from '../ipc-handlers/claude-code-handlers';

registerClaudeCodeHandlers();
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { send: vi.fn() } }, ...args);

beforeEach(() => {
  wslRef.on = false;
  fsRef.windowsTerminal = true;
  process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local';
  settingsRef.current = {
    gitPath: '/usr/local/bin/git',
    pythonPath: '/usr/bin/python3',
    githubCLIPath: '/usr/local/bin/gh',
    wslToolPaths: { git: '/usr/bin/git' },
  };
  settingsRef.written = [];
  tools.configureTools.mockClear();
  proc.spawn.mockClear();
  runtime.runTool.mockClear();
  wslExec.execInWsl.mockReset();
});

describe('set active Claude CLI path', () => {
  it('keeps the other tool paths, WSL ones included', async () => {
    const result = await call(IPC_CHANNELS.CLAUDE_CODE_SET_ACTIVE_PATH, '/opt/claude/bin/claude') as { success: boolean };

    expect(result.success).toBe(true);
    expect(tools.configureTools).toHaveBeenCalledWith(expect.objectContaining({
      claudePath: expect.stringContaining('claude'),
      gitPath: '/usr/local/bin/git',
      pythonPath: '/usr/bin/python3',
      githubCLIPath: '/usr/local/bin/gh',
      wslToolPaths: { git: '/usr/bin/git' },
    }));
  });

  it('in WSL saves a Linux path as wslToolPaths.claude, checked inside WSL', async () => {
    wslRef.on = true;
    const result = await call(IPC_CHANNELS.CLAUDE_CODE_SET_ACTIVE_PATH, '/home/me/.local/bin/claude') as { success: boolean; data?: { path: string } };

    expect(result).toEqual({ success: true, data: { path: '/home/me/.local/bin/claude' } });
    expect(runtime.runTool).toHaveBeenCalledWith('claude', ['--version'], expect.objectContaining({ command: '/home/me/.local/bin/claude' }));
    const written = settingsRef.written.at(-1)!;
    expect(written.wslToolPaths).toEqual({ git: '/usr/bin/git', claude: '/home/me/.local/bin/claude' });
    expect(written.claudePath).toBeUndefined();
    expect(tools.configureTools).toHaveBeenCalledWith(expect.objectContaining({
      gitPath: '/usr/local/bin/git',
      wslToolPaths: { git: '/usr/bin/git', claude: '/home/me/.local/bin/claude' },
    }));
  });

  it('in WSL rejects a Windows path', async () => {
    wslRef.on = true;
    const result = await call(IPC_CHANNELS.CLAUDE_CODE_SET_ACTIVE_PATH, 'C:\\Users\\me\\.local\\bin\\claude.exe') as { success: boolean };
    expect(result.success).toBe(false);
    expect(settingsRef.written).toEqual([]);
  });
});

describe('WSL console', () => {
  const options = { distro: 'Ubuntu', wslExe: 'C:\\Windows\\System32\\wsl.exe', comSpec: 'C:\\Windows\\System32\\cmd.exe' };

  it('opens a Windows Terminal tab running bash directly, with wt.exe separators escaped', () => {
    const launch = buildWslConsoleLaunch('pkill -x claude; claude install --force latest', { ...options, windowsTerminal: 'C:\\wt.exe' });
    expect(launch).toEqual({
      file: 'C:\\wt.exe',
      args: [
        'new-tab', '--', 'C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-lic',
        'pkill -x claude\\; claude install --force latest\\; exec bash',
      ],
    });
  });

  it('opens a console window of its own without Windows Terminal', () => {
    const launch = buildWslConsoleLaunch("env CLAUDE_CONFIG_DIR='/home/me/.claude-2' claude auth login", { ...options, windowsTerminal: null });
    expect(launch).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d', '/c', 'start', '', 'C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-lic',
        "env CLAUDE_CONFIG_DIR='/home/me/.claude-2' claude auth login; exec bash",
      ],
    });
    expect(() => buildWslConsoleLaunch('echo "%PATH%"', { ...options, windowsTerminal: null })).toThrow();
  });

  it('installs Claude Code with the Linux installer in a WSL console', async () => {
    wslRef.on = true;
    tools.getToolInfo.mockResolvedValue({ found: false });

    const result = await call(IPC_CHANNELS.CLAUDE_CODE_INSTALL) as { success: boolean; data?: { command: string } };

    expect(result.data?.command).toBe('curl -fsSL https://claude.ai/install.sh | bash -s -- latest');
    expect(proc.spawn).toHaveBeenCalledTimes(1);
    const [file, args] = proc.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(file).toMatch(/wt\.exe$/i);
    expect(args.slice(0, 8)).toEqual(['new-tab', '--', 'C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-lic']);
    expect(args[8]).toBe('curl -fsSL https://claude.ai/install.sh | bash -s -- latest\\; exec bash');
  });
});

describe('Claude CLI installations in WSL', () => {
  it('lists the ones found inside WSL, the configured one active', async () => {
    wslRef.on = true;
    settingsRef.current = { claudePath: 'C:\\claude.exe', wslToolPaths: { claude: '/opt/claude' } };
    wslExec.execInWsl.mockResolvedValue({
      stdout: '/opt/claude\t2.0.1 (Claude Code)\n/home/me/.local/bin/claude\t2.1.307 (Claude Code)\n/home/me/.local/bin/claude\t2.1.307 (Claude Code)\n',
      stderr: '',
    });

    const result = await call(IPC_CHANNELS.CLAUDE_CODE_GET_INSTALLATIONS) as { success: boolean; data: { installations: unknown[]; activePath: string } };

    expect(result.data.activePath).toBe('/opt/claude');
    expect(result.data.installations).toEqual([
      { path: '/opt/claude', version: '2.0.1', source: 'user-config', isActive: true },
      { path: '/home/me/.local/bin/claude', version: '2.1.307', source: 'wsl', isActive: false },
    ]);
    const [file, args] = wslExec.execInWsl.mock.calls[0] as [string, string[]];
    expect(file).toBe('/bin/sh');
    // The mount root (Windows shims are skipped), then the candidates
    expect(args.slice(3, 6)).toEqual(['/mnt/', '/opt/claude', '/home/me/.local/bin/claude']);
  });
});
