/**
 * Startup check of the tools' runtime (worktree/runtime-switch), Windows only:
 * - the runtime and each runtime's git version are stored; worktrees are repaired for every
 *   project when the runtime differs from the last start (a first start counts as after native)
 * - in WSL, a core.autocrlf difference between Windows git and WSL git is reported
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  windows: true,
  wsl: null as null | { distro: string; mountRoot: string; home: string; tools: { git: { path: string | null; version: string | null } } },
  nativeGitVersion: '2.53.0',
  nativeAutocrlf: 'true' as string | null,
  wslAutocrlf: 'input' as string | null,
  repair: vi.fn(),
  setKnownGitVersions: vi.fn(),
  setAutocrlfMismatch: vi.fn(),
  warn: vi.fn(),
  runTool: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../platform', () => ({ isWindows: () => mocks.windows }));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  isWslRuntime: () => mocks.wsl !== null,
  getWslInfo: () => mocks.wsl,
  setAutocrlfMismatch: mocks.setAutocrlfMismatch,
}));
vi.mock('../../platform/runtime-exec', () => ({ runTool: mocks.runTool }));
vi.mock('../../cli-tool-manager', () => ({
  getToolInfoAsync: async () => ({ found: true, version: mocks.nativeGitVersion, source: 'system-path', message: '' }),
}));
vi.mock('../../project-store', () => ({ projectStore: { getProjects: () => [] } }));
vi.mock('../../settings-utils', () => ({ readSettingsFile: () => ({ gitPath: undefined }) }));
vi.mock('../../utils/windows-paths', () => ({
  findWindowsExecutableViaWhereAsync: async () => 'C:\\Program Files\\Git\\cmd\\git.exe',
  getWindowsExecutablePathsAsync: async () => [],
  WINDOWS_GIT_PATHS: {},
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: mocks.execFile,
}));
vi.mock('../runtime-worktrees', () => ({
  repairProjectWorktrees: mocks.repair,
  setKnownGitVersions: mocks.setKnownGitVersions,
  setWslPathHints: vi.fn(),
  useRelativeWorktreePaths: async () => false,
}));

import { autocrlfDiffers, checkRuntimeAtStartup, readRuntimeState } from '../runtime-switch';

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

let dir: string;
let stateFile: string;
let projectDir: string;

const UBUNTU = { distro: 'Ubuntu', mountRoot: '/mnt/', home: '/home/me', tools: { git: { path: '/usr/bin/git', version: '2.43.0' } } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows = true;
  mocks.wsl = null;
  mocks.nativeAutocrlf = 'true';
  mocks.wslAutocrlf = 'input';
  dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-switch-'));
  stateFile = path.join(dir, 'shell-runtime-state.json');
  // A project that is a git repository (only those are repaired)
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'runtime-switch-project-'));
  writeFileSync(path.join(projectDir, '.git'), 'gitdir: elsewhere\n');
  mocks.repair.mockResolvedValue({ repaired: [] });
  // Windows git, run directly
  mocks.execFile.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    if (args[0] === '--version') return callback(null, { stdout: 'git version 2.53.0.windows.1\n', stderr: '' });
    if (mocks.nativeAutocrlf === null) return callback(Object.assign(new Error('exit 1'), { code: 1 }));
    return callback(null, { stdout: `${mocks.nativeAutocrlf}\n`, stderr: '' });
  });
  // WSL git, through the runtime layer
  mocks.runTool.mockImplementation(async () => {
    if (mocks.wslAutocrlf === null) throw Object.assign(new Error('exit 1'), { code: 1 });
    return { stdout: `${mocks.wslAutocrlf}\n`, stderr: '' };
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const start = () => checkRuntimeAtStartup({ stateFile, projectPaths: () => [projectDir] });

describe('repair on a runtime change', () => {
  it('a first native start records the runtime without repairing', async () => {
    await start();
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(await readRuntimeState(stateFile)).toEqual({ runtime: 'native', gitVersions: { native: '2.53.0', wsl: undefined } });
  });

  it('repairs every project when the app starts in WSL after native sessions', async () => {
    writeFileSync(stateFile, JSON.stringify({ runtime: 'native', gitVersions: { native: '2.53.0' } }));
    mocks.wsl = UBUNTU;
    await start();
    expect(mocks.repair).toHaveBeenCalledWith(projectDir, { all: true });
    const stored = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(stored).toEqual({
      runtime: 'wsl',
      gitVersions: { native: '2.53.0', wsl: '2.43.0' },
      wsl: { distro: 'Ubuntu', mountRoot: '/mnt/' },
    });
    expect(mocks.setKnownGitVersions).toHaveBeenCalledWith({ native: '2.53.0', wsl: '2.43.0' });
  });

  it('repairs again when switching back to native, keeping the WSL git version', async () => {
    writeFileSync(stateFile, JSON.stringify({ runtime: 'wsl', gitVersions: { native: '2.53.0', wsl: '2.49.0' }, wsl: { distro: 'Ubuntu', mountRoot: '/mnt/' } }));
    await start();
    expect(mocks.repair).toHaveBeenCalledTimes(1);
    expect(mocks.setKnownGitVersions).toHaveBeenCalledWith({ native: '2.53.0', wsl: '2.49.0' });
  });

  it("doesn't repair when the runtime is the same as last time", async () => {
    writeFileSync(stateFile, JSON.stringify({ runtime: 'wsl', gitVersions: {} }));
    mocks.wsl = UBUNTU;
    await start();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it('does nothing off Windows', async () => {
    mocks.windows = false;
    await start();
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(await readRuntimeState(stateFile)).toBeNull();
  });
});

describe('line endings in WSL', () => {
  it('reports differing core.autocrlf values', async () => {
    mocks.wsl = UBUNTU;
    await start();
    expect(mocks.setAutocrlfMismatch).toHaveBeenCalledWith({ windows: 'true', wsl: 'input' });
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('core.autocrlf differs'));
    // WSL git read in the Linux home, so no repository's own config applies
    expect(mocks.runTool).toHaveBeenCalledWith('git', ['-C', '/home/me', 'config', '--get', 'core.autocrlf'], expect.anything());
  });

  it('treats an unset value like false', async () => {
    mocks.wsl = UBUNTU;
    mocks.nativeAutocrlf = 'false';
    mocks.wslAutocrlf = null;
    await start();
    expect(mocks.setAutocrlfMismatch).toHaveBeenCalledWith(null);
    expect(autocrlfDiffers('unset', 'false')).toBe(false);
    expect(autocrlfDiffers('true', 'unset')).toBe(true);
  });

  it("isn't checked natively", async () => {
    await start();
    expect(mocks.setAutocrlfMismatch).not.toHaveBeenCalled();
  });
});
