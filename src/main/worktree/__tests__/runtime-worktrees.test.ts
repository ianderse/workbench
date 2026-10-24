/**
 * Worktrees shared by Windows git and WSL git (worktree/runtime-worktrees):
 * - relative links (git 2.48+) only when every git that may open the repository supports them
 * - links in the other runtime's format are read back as host paths and repaired before a prune
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  windows: true,
  macos: false,
  /** Whether `/usr/bin/git` is there (decided here, so the test is the same on every host) */
  systemGitExists: false,
  wsl: null as null | { distro: string; mountRoot: string; tools: { git: { path: string | null; version: string | null } } },
  nativeGit: { found: true, version: '2.53.0' } as { found: boolean; version?: string; path?: string },
  git: vi.fn(),
  runTool: vi.fn(),
}));

vi.mock('../../platform', () => ({ isWindows: () => mocks.windows, isMacOS: () => mocks.macos }));
vi.mock('../../platform/runtime-exec', () => ({ runTool: mocks.runTool }));
vi.mock('../../platform/shell-runtime', () => ({
  isWslRuntime: () => mocks.wsl !== null,
  getWslInfo: () => mocks.wsl,
}));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: async () => mocks.nativeGit }));
vi.mock('../../utils/git-exec', () => ({ git: mocks.git }));

/** Host paths (Windows ones on any test host) that count as existing */
const existing = vi.hoisted(() => new Set<string>());
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: string) =>
      p === '/usr/bin/git' ? mocks.systemGitExists : existing.has(p) || actual.existsSync(p),
  };
});

import {
  gitSupportsRelativeWorktrees,
  parseRecordedGitdir,
  repairForeignWorktrees,
  repairProjectWorktrees,
  resetRuntimeWorktreesForTests,
  setKnownGitVersions,
  useRelativeWorktreePaths,
  worktreeGitArgs,
  worktreePathKey,
} from '../runtime-worktrees';

const UBUNTU = (version: string | null) => ({ distro: 'Ubuntu', mountRoot: '/mnt/', tools: { git: { path: version ? '/usr/bin/git' : null, version } } });

beforeEach(() => {
  vi.clearAllMocks();
  resetRuntimeWorktreesForTests();
  mocks.windows = true;
  mocks.macos = false;
  mocks.systemGitExists = false;
  mocks.wsl = null;
  mocks.nativeGit = { found: true, version: '2.53.0' };
  mocks.git.mockResolvedValue({ stdout: '', stderr: '' });
  mocks.runTool.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('gitSupportsRelativeWorktrees', () => {
  it('needs git 2.48 or newer', () => {
    expect(gitSupportsRelativeWorktrees('2.48.0')).toBe(true);
    expect(gitSupportsRelativeWorktrees('2.53.0.windows.1')).toBe(true);
    expect(gitSupportsRelativeWorktrees('3.0')).toBe(true);
    expect(gitSupportsRelativeWorktrees('2.47.2')).toBe(false);
    expect(gitSupportsRelativeWorktrees('2.43.0')).toBe(false);
    expect(gitSupportsRelativeWorktrees(null)).toBe(false);
    expect(gitSupportsRelativeWorktrees(undefined)).toBe(false);
  });
});

describe('relative worktree links by git version', () => {
  it('off Windows: whenever git is 2.48+', async () => {
    mocks.windows = false;
    expect(await useRelativeWorktreePaths()).toBe(true);
    expect(await worktreeGitArgs(['worktree', 'add', '/p/wt', 'main'])).toEqual(
      ['-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '/p/wt', 'main']
    );
    mocks.nativeGit = { found: true, version: '2.47.0' };
    expect(await worktreeGitArgs(['worktree', 'add', '/p/wt', 'main'])).toEqual(['worktree', 'add', '/p/wt', 'main']);
  });

  it('on Windows natively: only when WSL git is known to be 2.48+ (or known to be missing)', async () => {
    // WSL git never seen: absolute links, which an older WSL git can still open
    expect(await useRelativeWorktreePaths()).toBe(false);
    setKnownGitVersions({ native: '2.53.0', wsl: '2.43.0' });
    expect(await useRelativeWorktreePaths()).toBe(false);
    setKnownGitVersions({ native: '2.53.0', wsl: '2.49.0' });
    expect(await useRelativeWorktreePaths()).toBe(true);
    setKnownGitVersions({ native: '2.53.0', wsl: null });
    expect(await useRelativeWorktreePaths()).toBe(true);
    mocks.nativeGit = { found: true, version: '2.45.1' };
    expect(await useRelativeWorktreePaths()).toBe(false);
  });

  it('in WSL: the probed git version, and Windows git known to be 2.48+', async () => {
    mocks.wsl = UBUNTU('2.43.0');
    setKnownGitVersions({ native: '2.53.0', wsl: '2.43.0' });
    expect(await useRelativeWorktreePaths()).toBe(false);
    mocks.wsl = UBUNTU('2.48.1');
    setKnownGitVersions({ native: '2.53.0', wsl: '2.48.1' });
    expect(await worktreeGitArgs(['worktree', 'add', 'C:\\p\\wt'])).toEqual(
      ['-c', 'worktree.useRelativePaths=true', 'worktree', 'add', 'C:\\p\\wt']
    );
    setKnownGitVersions({ native: '2.40.0', wsl: '2.48.1' });
    expect(await useRelativeWorktreePaths()).toBe(false);
    setKnownGitVersions({ native: undefined, wsl: '2.48.1' });
    expect(await useRelativeWorktreePaths()).toBe(false);
  });
});

describe('relative worktree links on macOS', () => {
  beforeEach(() => {
    mocks.windows = false;
    mocks.macos = true;
    mocks.systemGitExists = true;
    // Homebrew git first on PATH
    mocks.nativeGit = { found: true, version: '2.53.0', path: '/opt/homebrew/bin/git' };
  });

  it('uses absolute links while Apple git is also on the machine', async () => {
    mocks.runTool.mockResolvedValue({ stdout: 'git version 2.39.5 (Apple Git-154)\n', stderr: '' });
    expect(await useRelativeWorktreePaths()).toBe(false);
    expect(mocks.runTool).toHaveBeenCalledWith(
      'git',
      ['--version'],
      expect.objectContaining({ command: '/usr/bin/git' })
    );
    // Probed once, however many worktrees are created
    await useRelativeWorktreePaths();
    expect(mocks.runTool).toHaveBeenCalledTimes(1);
  });

  it('uses relative links when the system git is 2.48+ too', async () => {
    mocks.runTool.mockResolvedValue({ stdout: 'git version 2.49.0\n', stderr: '' });
    expect(await useRelativeWorktreePaths()).toBe(true);
  });

  it('uses absolute links when the system git does not answer', async () => {
    mocks.runTool.mockRejectedValue(new Error('xcode-select: no developer tools'));
    expect(await useRelativeWorktreePaths()).toBe(false);
  });

  it('asks no second git when there is no /usr/bin/git, or it is the one in use', async () => {
    mocks.systemGitExists = false;
    expect(await useRelativeWorktreePaths()).toBe(true);

    mocks.systemGitExists = true;
    mocks.nativeGit = { found: true, version: '2.53.0', path: '/usr/bin/git' };
    expect(await useRelativeWorktreePaths()).toBe(true);
    expect(mocks.runTool).not.toHaveBeenCalled();
  });

  it('does not ask on Linux', async () => {
    mocks.macos = false;
    expect(await useRelativeWorktreePaths()).toBe(true);
    expect(mocks.runTool).not.toHaveBeenCalled();
  });
});

describe('worktreePathKey', () => {
  it('reads the two WSL UNC prefixes as the same folder (the worktree stays)', () => {
    const wslDollar = '\\\\wsl$\\Ubuntu\\home\\me\\proj\\.workbench\\worktrees\\tasks\\001';
    const localhost = '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\.workbench\\worktrees\\tasks\\001';
    expect(worktreePathKey(wslDollar)).toBe(worktreePathKey(localhost));
    // Windows git writes UNC paths with forward slashes
    expect(worktreePathKey('//wsl.localhost/Ubuntu/home/me/proj/.workbench/worktrees/tasks/001')).toBe(
      worktreePathKey(wslDollar)
    );
    // The distribution name and the drive letter are compared without case
    expect(worktreePathKey('\\\\WSL.LOCALHOST\\ubuntu\\home\\me\\proj')).toBe(
      worktreePathKey('\\\\wsl$\\Ubuntu\\home\\me\\proj')
    );
    expect(worktreePathKey('c:/repo/wt')).toBe(worktreePathKey('C:\\repo\\wt'));
    // Different worktrees stay different
    expect(worktreePathKey('\\\\wsl$\\Ubuntu\\home\\me\\a')).not.toBe(worktreePathKey('\\\\wsl$\\Ubuntu\\home\\me\\b'));
    expect(worktreePathKey('\\\\wsl$\\Debian\\home\\me\\a')).not.toBe(worktreePathKey('\\\\wsl$\\Ubuntu\\home\\me\\a'));
  });

  it('off Windows, only resolves (paths are case-sensitive there)', () => {
    mocks.windows = false;
    expect(worktreePathKey('/home/me/proj/wt/')).toBe(path.resolve('/home/me/proj/wt'));
    expect(worktreePathKey('/home/me/proj/WT')).not.toBe(worktreePathKey('/home/me/proj/wt'));
  });
});

describe('parseRecordedGitdir', () => {
  it('reads every format as a host path', () => {
    expect(parseRecordedGitdir('C:/repo/.workbench/worktrees/tasks/t1/.git\n', 'C:\\repo\\.git\\worktrees\\t1')).toEqual({
      path: 'C:\\repo\\.workbench\\worktrees\\tasks\\t1',
      format: 'windows',
    });
    expect(parseRecordedGitdir('/mnt/c/repo/wt/.git', 'C:\\repo\\.git\\worktrees\\wt', { distro: 'Ubuntu', mountRoot: '/mnt/' })).toEqual({
      path: 'C:\\repo\\wt',
      format: 'posix',
    });
    expect(parseRecordedGitdir('/home/me/repo/wt/.git', 'x', { distro: 'Ubuntu' })).toEqual({
      path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\wt',
      format: 'posix',
    });
    // A path inside an unknown distribution can't be reached
    expect(parseRecordedGitdir('/home/me/repo/wt/.git', 'x', {}).path).toBeNull();
    // Windows git writing a UNC path uses forward slashes: still a Windows link, not a path
    // inside the distribution
    expect(parseRecordedGitdir('//wsl.localhost/Ubuntu/home/me/repo/wt/.git', 'x', { distro: 'Ubuntu' })).toEqual({
      path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\wt',
      format: 'windows',
    });
    expect(parseRecordedGitdir('//wsl$/Ubuntu/home/me/repo/wt/.git', 'x', { distro: 'Ubuntu' })).toEqual({
      path: '\\\\wsl$\\Ubuntu\\home\\me\\repo\\wt',
      format: 'windows',
    });
    const relative = parseRecordedGitdir('../../../wt/.git', path.join('C:\\repo', '.git', 'worktrees', 'wt'));
    expect(relative.format).toBe('relative');
    expect(relative.path).toBe(path.resolve(path.join('C:\\repo', '.git', 'worktrees', 'wt'), '../../../wt'));
  });
});

describe('repair', () => {
  let repo: string;

  /** The main repository's record of a linked worktree (its folder counts as existing) */
  function record(id: string, gitdir: string, folder: string) {
    mkdirSync(path.join(repo, '.git', 'worktrees', id), { recursive: true });
    writeFileSync(path.join(repo, '.git', 'worktrees', id, 'gitdir'), `${gitdir}\n`);
    existing.add(path.join(folder, '.git'));
  }

  beforeEach(() => {
    existing.clear();
    repo = mkdtempSync(path.join(os.tmpdir(), 'runtime-worktrees-'));
    mkdirSync(path.join(repo, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('natively on Windows, repairs the worktrees WSL git linked (before a prune)', async () => {
    record('a', 'C:/repo/a/.git', 'C:\\repo\\a');
    record('b', '/mnt/c/repo/b/.git', 'C:\\repo\\b');
    record('gone', '/mnt/c/repo/gone/.git', 'C:\\elsewhere');

    await repairForeignWorktrees(repo);
    expect(mocks.git).toHaveBeenCalledTimes(1);
    expect(mocks.git).toHaveBeenCalledWith(['worktree', 'repair', 'C:\\repo\\b'], expect.objectContaining({ cwd: repo, isolated: true }));
  });

  it('in WSL, repairs the worktrees Windows git linked', async () => {
    mocks.wsl = UBUNTU('2.43.0');
    record('a', 'C:/repo/a/.git', 'C:\\repo\\a');
    record('b', '/mnt/c/repo/b/.git', 'C:\\repo\\b');

    const result = await repairProjectWorktrees(repo);
    expect(result).toEqual({ repaired: ['C:\\repo\\a'] });
    expect(mocks.git).toHaveBeenCalledWith(['worktree', 'repair', 'C:\\repo\\a'], expect.anything());
  });

  it('in WSL, repairs a worktree Windows git linked in the distribution home with forward slashes', async () => {
    mocks.wsl = UBUNTU('2.43.0');
    record('a', '//wsl.localhost/Ubuntu/home/me/proj/wt/.git', '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\wt');

    // Without this the link reads as a path inside the distribution, the worktree is left
    // unrepaired, and the prune that follows deletes it
    const result = await repairProjectWorktrees(repo);
    expect(result).toEqual({ repaired: ['\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\wt'] });
  });

  it('makes no git call when every link fits this runtime', async () => {
    record('a', 'C:/repo/a/.git', 'C:\\repo\\a');
    await repairForeignWorktrees(repo);
    expect(mocks.git).not.toHaveBeenCalled();
  });

  it('with all (runtime changed), repairs every worktree, switching to relative links when safe', async () => {
    mocks.wsl = UBUNTU('2.49.0');
    setKnownGitVersions({ native: '2.53.0', wsl: '2.49.0' });
    record('a', 'C:/repo/a/.git', 'C:\\repo\\a');
    record('b', '/mnt/c/repo/b/.git', 'C:\\repo\\b');

    const result = await repairProjectWorktrees(repo, { all: true });
    expect(result.repaired).toEqual(['C:\\repo\\a', 'C:\\repo\\b']);
    expect(mocks.git).toHaveBeenCalledWith(
      ['-c', 'worktree.useRelativePaths=true', 'worktree', 'repair', 'C:\\repo\\a', 'C:\\repo\\b'],
      expect.objectContaining({ cwd: repo })
    );
  });

  it('reports a failed repair instead of throwing', async () => {
    mocks.wsl = UBUNTU('2.43.0');
    record('a', 'C:/repo/a/.git', 'C:\\repo\\a');
    mocks.git.mockRejectedValue(Object.assign(new Error('Command failed'), { stderr: 'fatal: broken\n' }));
    expect(await repairProjectWorktrees(repo, { all: true })).toEqual({ repaired: ['C:\\repo\\a'], error: 'fatal: broken' });
  });

  it('does nothing off Windows (one git uses the repository)', async () => {
    mocks.windows = false;
    record('a', '/mnt/c/repo/a/.git', '/mnt/c/repo/a');
    expect(await repairProjectWorktrees(repo, { all: true })).toEqual({ repaired: [] });
    expect(mocks.git).not.toHaveBeenCalled();
  });
});
