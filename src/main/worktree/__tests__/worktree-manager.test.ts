/**
 * Worktree creation (worktree/worktree-manager): a worktree folder that git still has a
 * registration for is used again, never deleted. The path git lists and the path the app expects
 * can be different spellings of the same folder — a project added as `\\wsl$\<distro>\…` is
 * listed by WSL git as `\\wsl.localhost\<distro>\…` — and a worktree that only looks stale would
 * be removed with the uncommitted work in it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// runtime-worktrees reads the admin dir through `promises` from 'fs', not 'fs/promises', so both
// have to serve the same fixture or the real filesystem answers

const PROJECT = '\\\\wsl$\\Ubuntu\\home\\me\\proj';
const SPEC_ID = '001-feature';
const WORKTREE = path.join(PROJECT, '.workbench/worktrees/tasks', SPEC_ID);

const mocks = vi.hoisted(() => ({
  windows: true,
  /** `git worktree list --porcelain`, as the git of this session writes it */
  worktreeList: '',
  /** Folders that exist on this (pretend Windows) host */
  existing: new Set<string>(),
  git: vi.fn(),
  rm: vi.fn(async (p: string) => {
    mocks.existing.delete(p);
  }),
  cp: vi.fn(async () => {}),
  /** `.git/worktrees/<id>/gitdir` contents, by worktree id; empty means no linked worktrees */
  recorded: {} as Record<string, string>,
  /** The admin-dir reads `listRecordedWorktrees` makes, served from `recorded` */
  adminReads: {
    readdir: async (dir: string) => {
      const ids = Object.keys(mocks.recorded);
      if (!dir.endsWith(`.git${path.sep}worktrees`) || ids.length === 0) throw new Error('ENOENT');
      return ids;
    },
    readFile: async (file: string) => {
      const content = mocks.recorded[path.basename(path.dirname(file))];
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
  },
  /**
   * How the targeted prune unregisters one worktree: it removes its admin directory, through
   * `promises` from 'fs'. Kept apart from the 'fs/promises' `rm` worktree-manager uses for the
   * stale-directory delete, so neither can stand in for the other.
   */
  adminRm: vi.fn(async (dir: string) => {
    delete mocks.recorded[path.basename(dir)];
  }),
  /** Whether `git worktree repair` fails, as it does when the other runtime's git wrote the link */
  repairFails: false,
  /** The distribution, or null for the native runtime - where a WSL link cannot be translated */
  wsl: { distro: 'Ubuntu', mountRoot: '/mnt/' } as { distro: string; mountRoot: string } | null,
}));

vi.mock('../../platform', () => ({ isWindows: () => mocks.windows, isMacOS: () => false }));
vi.mock('../../platform/runtime-exec', () => ({ runTool: vi.fn() }));
vi.mock('../../platform/shell-runtime', () => ({
  isWslRuntime: () => mocks.wsl !== null,
  getWslInfo: () =>
    mocks.wsl ? { ...mocks.wsl, tools: { git: { path: '/usr/bin/git', version: '2.43.0' } } } : undefined,
  // WSL git lists paths inside the distribution; the app reads them back as the canonical UNC form
  toHostPath: (p: string) => (p.startsWith('/') ? `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, '\\')}` : p),
}));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: async () => ({ found: true, version: '2.43.0' }) }));
vi.mock('../../utils/git-exec', () => ({ git: mocks.git }));
vi.mock('../../self-improve/setting', () => ({ isSelfImproveEnabledForPath: async () => false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: string) => mocks.existing.has(p),
    mkdirSync: vi.fn(),
    promises: { ...actual.promises, ...mocks.adminReads, rm: mocks.adminRm },
  };
});
vi.mock('fs/promises', () => ({ rm: mocks.rm, cp: mocks.cp, ...mocks.adminReads }));

import { createOrGetWorktree } from '../worktree-manager';

/**
 * Record the worktree in `.git/worktrees/<id>/gitdir` the way the OTHER runtime's git writes it: a
 * `\\wsl.localhost\…` link this session's git can't follow, which is what `worktree repair` is for.
 * The app reads that value back through `path.win32`, so the folder has to exist under that
 * spelling for the entry to count (these tests run on a POSIX host, where `path.join` differs).
 */
/** A registration whose folder nobody can find: what a worktree deleted outside the app leaves */
function recordStaleWorktree(id: string): void {
  mocks.recorded[id] = `\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\.workbench\\worktrees\\tasks\\${id}\\.git\n`;
}

function recordForeignWorktree({ folderExists = true } = {}): void {
  const link = `\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\.workbench\\worktrees\\tasks\\${SPEC_ID}\\.git`;
  mocks.recorded = { [SPEC_ID]: `${link}\n` };
  // Without the folder nothing resolves the registration, which is what makes it stale
  if (folderExists) mocks.existing.add(path.join(path.win32.normalize(link.replace(/\\\.git$/, '')), '.git'));
}

/** The worktree as WSL git lists it, which is the registration that must survive */
const LISTED_WORKTREE = [
  `worktree /home/me/proj/.workbench/worktrees/tasks/${SPEC_ID}`,
  'HEAD 2222222222222222222222222222222222222222',
  `branch refs/heads/workbench/${SPEC_ID}`,
  '',
].join('\n');

/** A recorded git call without its `-c <config>` options, e.g. "worktree list --porcelain" */
const subCommand = (args: string[]) => args.filter((a) => a !== '-c' && !a.includes('=')).join(' ');

function calls(): string[] {
  return mocks.git.mock.calls.map((call) => subCommand(call[0] as string[]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.windows = true;
  mocks.existing = new Set([WORKTREE]);
  mocks.worktreeList = '';
  mocks.recorded = {};
  mocks.repairFails = false;
  mocks.wsl = { distro: 'Ubuntu', mountRoot: '/mnt/' };
  mocks.git.mockImplementation(async (args: string[]) => {
    const sub = subCommand(args);
    if (sub.startsWith('worktree list')) return { stdout: mocks.worktreeList, stderr: '' };
    if (sub.startsWith('worktree repair') && mocks.repairFails) {
      throw Object.assign(new Error('repair failed'), { stderr: 'fatal: not a valid path' });
    }
    // The base branch resolves, so creation gets as far as `worktree add`
    if (sub.startsWith('rev-parse')) return { stdout: '2222222222222222222222222222222222222222', stderr: '' };
    return { stdout: '', stderr: '' };
  });
});

describe('createOrGetWorktree with an existing worktree folder', () => {
  it('keeps a worktree WSL git lists under the other UNC prefix', async () => {
    mocks.worktreeList = [
      'worktree /home/me/proj',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      `worktree /home/me/proj/.workbench/worktrees/tasks/${SPEC_ID}`,
      'HEAD 2222222222222222222222222222222222222222',
      `branch refs/heads/workbench/${SPEC_ID}`,
      '',
    ].join('\n');

    const result = await createOrGetWorktree(PROJECT, SPEC_ID);

    expect(result.branch).toBe(`workbench/${SPEC_ID}`);
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(calls().some((call) => call.startsWith('worktree add'))).toBe(false);
  });

  it('leaves a registration alone when its link is one this git cannot follow', async () => {
    // The repair could not fix a link the other runtime's git wrote, so a prune would report the
    // worktree as broken and unregister it even though the folder is there - and the
    // stale-directory step would then delete it with the task's uncommitted work in it
    recordForeignWorktree();
    mocks.repairFails = true;
    mocks.worktreeList = LISTED_WORKTREE;

    await createOrGetWorktree(PROJECT, SPEC_ID);

    expect(calls().some((call) => call.startsWith('worktree repair'))).toBe(true);
    expect(calls()).not.toContain('worktree prune');
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it('prunes a registration whose folder is really gone, so the task is not blocked', async () => {
    // Recorded, but nothing resolves it any more: the user deleted the folder outside the app, and
    // without the prune the next `worktree add` fails on a branch a dead registration still claims
    recordForeignWorktree({ folderExists: false });
    mocks.existing.delete(WORKTREE);
    mocks.worktreeList = 'worktree /home/me/proj\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n';

    await createOrGetWorktree(PROJECT, SPEC_ID, 'main', false, false);

    expect(calls()).toContain('worktree prune');
  });

  /**
   * One worktree with an unrepairable link must not make the project unprunable: the registration
   * of a worktree somebody deleted by hand still claims its branch, so leaving it would turn a
   * state that heals itself into a task that can never start again.
   */
  it('still clears a stale registration while another worktree cannot be followed', async () => {
    recordForeignWorktree();
    recordStaleWorktree('002-other');
    mocks.repairFails = true;
    mocks.worktreeList = LISTED_WORKTREE;

    await createOrGetWorktree(PROJECT, SPEC_ID);

    // Not the blunt prune, which would have unregistered the worktree still on disk
    expect(calls()).not.toContain('worktree prune');
    // The one nothing resolves is gone; the one on disk keeps its registration
    expect(mocks.adminRm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mocks.adminRm).mock.calls[0][0]).toContain('002-other');
    expect(mocks.recorded[SPEC_ID]).toBeDefined();
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  /**
   * A link whose recorded path cannot be translated is not a worktree that is gone. The native
   * runtime cannot read a WSL-written path until it knows the distribution's name, and a task start
   * can reach this before the runtime check has filled that in - while the folder is right there on
   * disk, holding the task's uncommitted work.
   */
  it('keeps a registration whose link it could not resolve at all', async () => {
    // Native runtime, so nothing can name the distribution the link was written for
    mocks.wsl = null;
    mocks.recorded = { [SPEC_ID]: '/home/me/proj/.workbench/worktrees/tasks/001-feature/.git\n' };
    mocks.existing.add(path.join(WORKTREE, '.git'));
    mocks.worktreeList = LISTED_WORKTREE;

    await createOrGetWorktree(PROJECT, SPEC_ID);

    // Neither unregistered by hand nor by a blunt prune, and the folder is left alone
    expect(mocks.adminRm).not.toHaveBeenCalled();
    expect(calls()).not.toContain('worktree prune');
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.recorded[SPEC_ID]).toBeDefined();
  });

  it('still clears a folder that is really gone beside a link it could not resolve', async () => {
    mocks.wsl = null;
    mocks.recorded = {
      [SPEC_ID]: '/home/me/proj/.workbench/worktrees/tasks/001-feature/.git\n',
      '002-other': `${path.join(PROJECT, '.workbench', 'worktrees', 'tasks', '002-other')}\\.git\n`,
    };
    mocks.existing.add(path.join(WORKTREE, '.git'));
    mocks.worktreeList = LISTED_WORKTREE;

    await createOrGetWorktree(PROJECT, SPEC_ID);

    // The resolvable one whose folder is absent goes; the unresolvable one stays
    expect(vi.mocked(mocks.adminRm).mock.calls.map((call) => path.basename(String(call[0])))).toEqual(['002-other']);
    expect(mocks.recorded[SPEC_ID]).toBeDefined();
  });

  it('prunes when every registration left is one this git can follow', async () => {
    // A relative link (what `worktree repair` leaves behind when it succeeds) is readable by either
    // runtime's git, so there is nothing a prune could wrongly drop
    mocks.recorded = { [SPEC_ID]: `../../worktrees/tasks/${SPEC_ID}/.git\n` };
    mocks.existing.add(path.join(WORKTREE, '.git'));
    mocks.worktreeList = LISTED_WORKTREE;

    await createOrGetWorktree(PROJECT, SPEC_ID);

    expect(calls()).toContain('worktree prune');
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it('removes a folder git has no registration for', async () => {
    mocks.worktreeList = 'worktree /home/me/proj\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n';

    await createOrGetWorktree(PROJECT, SPEC_ID, 'main', false, false);

    expect(mocks.rm).toHaveBeenCalledWith(WORKTREE, { recursive: true, force: true });
    expect(calls().some((call) => call.startsWith('worktree add'))).toBe(true);
  });
});
