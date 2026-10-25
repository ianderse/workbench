/**
 * Autonomous mode git operations (real git repos):
 * - the integration branch is created from the base branch once and kept
 * - new task branches start from it
 * - a task merges into the target with one --no-ff merge commit and the user's checkout stays put
 * - conflicts go to the merge agent; when it fails nothing changes
 * - a merge is reverted in a temporary worktree
 * - the integration branch merges into the base branch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({
  getToolPathAsync: async () => 'git',
  getToolInfoAsync: async () => ({ found: true, version: '2.43.0' }),
}));
vi.mock('../../self-improve/setting', () => ({ isSelfImproveEnabledForPath: async () => false }));

import {
  advanceBranch,
  autoMergeIntoTarget,
  countTasksAhead,
  ensureIntegrationBranch,
  localBranchSha,
  mergeIntegrationIntoBase,
  revertMergeOnTarget,
} from '../autonomous-git';
import { createOrGetWorktree } from '../../worktree/worktree-manager';

let tmp: string;
let project: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};
const parents = (sha: string) => git(project, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);

/** A task worktree on branch workbench/<id> cut from `from` */
const addTask = (id: string, from: string) => {
  const wt = path.join(tmp, `wt-${id}`);
  git(project, 'worktree', 'add', '-q', '-b', `workbench/${id}`, wt, from);
  return wt;
};

const mergeInput = (worktreePath: string, id: string, targetBranch = 'workbench/auto') => ({
  projectDir: project,
  worktreePath,
  targetBranch,
  taskTitle: `Task ${id}`,
  specId: id,
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'autonomous-git-'));
  project = path.join(tmp, 'project');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'commit.gpgsign', 'false');
  git(project, 'config', 'core.autocrlf', 'false');
  commitFile(project, 'a.txt', 'one\ntwo\nthree\n', 'base');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ensureIntegrationBranch', () => {
  it('creates the branch from the base branch once and keeps it', async () => {
    const first = await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    expect(first.created).toBe(true);
    expect(first.sha).toBe(git(project, 'rev-parse', 'main'));

    // The base moves on; the integration branch is not recreated or moved
    commitFile(project, 'later.txt', 'x\n', 'later on main');
    const second = await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    expect(second.created).toBe(false);
    expect(second.sha).toBe(first.sha);
  });

  it('fails clearly when the base branch does not exist', async () => {
    await expect(ensureIntegrationBranch(project, 'workbench/auto', 'nope')).rejects.toThrow(/nope/);
  });
});

describe('tasks branch from the target branch', () => {
  it('cuts a new task worktree from the integration branch, not from main', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const taskA = addTask('001-a', 'workbench/auto');
    commitFile(taskA, 'a-feature.txt', 'A\n', 'task a');
    expect((await autoMergeIntoTarget(mergeInput(taskA, '001-a'))).success).toBe(true);
    expect(existsSync(path.join(project, 'a-feature.txt'))).toBe(false);

    const created = await createOrGetWorktree(project, '002-b', 'workbench/auto', true, false);
    expect(created.worktreePath).toBeTruthy();
    expect(readFileSync(path.join(created.worktreePath, 'a-feature.txt'), 'utf-8')).toBe('A\n');
    expect(git(project, 'merge-base', '--is-ancestor', 'workbench/auto', 'workbench/002-b') ?? '').toBe('');
  });
});

describe('autoMergeIntoTarget', () => {
  it('merges with one --no-ff merge commit, records its sha and leaves the checkout alone', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const before = git(project, 'rev-parse', 'workbench/auto');
    const wt = addTask('001-a', 'workbench/auto');
    commitFile(wt, 'b.txt', 'from the task\n', 'task work');

    const result = await autoMergeIntoTarget(mergeInput(wt, '001-a'));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sha).toBe(git(project, 'rev-parse', 'workbench/auto'));
    const [first, second] = parents(result.sha);
    expect(first).toBe(before);
    expect(second).toBe(git(wt, 'rev-parse', 'HEAD'));
    expect(git(project, 'log', '-1', '--format=%s', result.sha)).toContain('001-a');
    // The user's checkout: still on main, clean, without the task's file
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(project, 'b.txt'))).toBe(false);
    // No temporary worktree is left behind
    expect(git(project, 'worktree', 'list')).not.toContain('workbench-auto-');
  });

  it('keeps one merge commit per task even when the target moved (the target is pulled into the task first)', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const one = addTask('001-a', 'workbench/auto');
    const two = addTask('002-b', 'workbench/auto');
    commitFile(one, 'one.txt', '1\n', 'task one');
    commitFile(two, 'two.txt', '2\n', 'task two');

    const first = await autoMergeIntoTarget(mergeInput(one, '001-a'));
    const second = await autoMergeIntoTarget(mergeInput(two, '002-b'));

    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.sha).not.toBe(first.sha);
    expect(parents(second.sha)).toHaveLength(2);
    expect(git(project, 'show', 'workbench/auto:one.txt')).toBe('1');
    expect(git(project, 'show', 'workbench/auto:two.txt')).toBe('2');
    expect(await countTasksAhead(project, 'workbench/auto', 'main')).toBe(2);
  });

  it('moves a target that is checked out in the project along with its checkout', async () => {
    const wt = addTask('001-a', 'main');
    commitFile(wt, 'b.txt', 'from the task\n', 'task work');

    const result = await autoMergeIntoTarget(mergeInput(wt, '001-a', 'main'));

    expect(result.success).toBe(true);
    expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  it('does nothing when the checked out target has local changes in the way', async () => {
    const wt = addTask('001-a', 'main');
    commitFile(wt, 'a.txt', 'one\ntwo changed by the task\nthree\n', 'task work');
    writeFileSync(path.join(project, 'a.txt'), 'local edit\n');
    const before = git(project, 'rev-parse', 'main');

    const result = await autoMergeIntoTarget(mergeInput(wt, '001-a', 'main'));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.kind).toBe('dirty_target');
    expect(git(project, 'rev-parse', 'main')).toBe(before);
    expect(readFileSync(path.join(project, 'a.txt'), 'utf-8')).toBe('local edit\n');
  });

  it('is a no-op when the target already has the task', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const wt = addTask('001-a', 'workbench/auto');
    const result = await autoMergeIntoTarget(mergeInput(wt, '001-a'));
    expect(result).toMatchObject({ success: true, alreadyMerged: true });
  });

  describe('conflicts', () => {
    const setup = async () => {
      await ensureIntegrationBranch(project, 'workbench/auto', 'main');
      const one = addTask('001-a', 'workbench/auto');
      const two = addTask('002-b', 'workbench/auto');
      commitFile(one, 'a.txt', 'one\nTWO from one\nthree\n', 'task one');
      commitFile(two, 'a.txt', 'one\nTWO from two\nthree\n', 'task two');
      expect((await autoMergeIntoTarget(mergeInput(one, '001-a'))).success).toBe(true);
      return two;
    };

    it('blocks and changes nothing when the merge agent cannot resolve them', async () => {
      const two = await setup();
      const targetBefore = git(project, 'rev-parse', 'workbench/auto');
      const taskBefore = git(two, 'rev-parse', 'HEAD');
      const mergeAgent = vi.fn(async () => ({ status: 'failed' as const, summary: 'cannot', intentionallyDropped: [] }));

      const result = await autoMergeIntoTarget({ ...mergeInput(two, '002-b'), mergeAgent });

      expect(mergeAgent).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.kind).toBe('conflicts');
        expect(result.conflictedFiles).toEqual(['a.txt']);
      }
      expect(git(project, 'rev-parse', 'workbench/auto')).toBe(targetBefore);
      expect(git(two, 'rev-parse', 'HEAD')).toBe(taskBefore);
      expect(git(two, 'status', '--porcelain')).toBe('');
    });

    it('merges after the merge agent resolved them, keeping both sides', async () => {
      const two = await setup();
      const mergeAgent = vi.fn(async (input: { worktreePath: string }) => {
        writeFileSync(path.join(input.worktreePath, 'a.txt'), 'one\nTWO from one\nTWO from two\nthree\n');
        git(input.worktreePath, 'add', 'a.txt');
        return { status: 'resolved' as const, summary: 'kept both', intentionallyDropped: [] };
      });

      const result = await autoMergeIntoTarget({ ...mergeInput(two, '002-b'), mergeAgent });

      expect(result.success).toBe(true);
      expect(git(project, 'show', 'workbench/auto:a.txt')).toContain('TWO from one');
      expect(git(project, 'show', 'workbench/auto:a.txt')).toContain('TWO from two');
    });

    it('hands the task backend to the merge agent (a task pinned to OMP or Claude Code)', async () => {
      const two = await setup();
      const mergeAgent = vi.fn(async (input: { worktreePath: string }) => {
        writeFileSync(path.join(input.worktreePath, 'a.txt'), 'one\nTWO from one\nTWO from two\nthree\n');
        git(input.worktreePath, 'add', 'a.txt');
        return { status: 'resolved' as const, summary: 'kept both', intentionallyDropped: [] };
      });

      const result = await autoMergeIntoTarget({ ...mergeInput(two, '002-b'), mergeAgent, backend: 'omp' });

      expect(result.success).toBe(true);
      expect(mergeAgent).toHaveBeenCalledWith(expect.objectContaining({ backend: 'omp' }));
    });
  });
});

describe('revertMergeOnTarget', () => {
  it('reverts the merge in a temporary worktree and leaves the main checkout untouched', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const wt = addTask('001-a', 'workbench/auto');
    commitFile(wt, 'b.txt', 'from the task\n', 'task work');
    const merged = await autoMergeIntoTarget(mergeInput(wt, '001-a'));
    if (!merged.success) throw new Error('setup failed');
    // The user has uncommitted work in the checkout
    writeFileSync(path.join(project, 'scratch.txt'), 'mine\n');

    const result = await revertMergeOnTarget(project, 'workbench/auto', merged.sha);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(git(project, 'rev-parse', 'workbench/auto')).toBe(result.sha);
    expect(() => git(project, 'cat-file', '-e', 'workbench/auto:b.txt')).toThrow();
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(path.join(project, 'scratch.txt'), 'utf-8')).toBe('mine\n');
    expect(git(project, 'worktree', 'list')).not.toContain('workbench-auto-');
  });

  it('refuses a commit that is not a merge', async () => {
    const result = await revertMergeOnTarget(project, 'main', git(project, 'rev-parse', 'main'));
    expect(result.success).toBe(false);
  });
});

describe('mergeIntegrationIntoBase', () => {
  it('merges the integration branch into the base branch and brings the integration branch up to date', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const wt = addTask('001-a', 'workbench/auto');
    commitFile(wt, 'b.txt', 'from the task\n', 'task work');
    expect((await autoMergeIntoTarget(mergeInput(wt, '001-a'))).success).toBe(true);
    // The base moved on meanwhile (a hotfix)
    commitFile(project, 'hotfix.txt', 'fix\n', 'hotfix on main');

    const result = await mergeIntegrationIntoBase(project, 'workbench/auto', 'main');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(git(project, 'rev-parse', 'main')).toBe(result.sha);
    expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
    expect(readFileSync(path.join(project, 'hotfix.txt'), 'utf-8')).toBe('fix\n');
    expect(result.integrationUpdated).toBe(true);
    expect(git(project, 'rev-parse', 'workbench/auto')).toBe(result.sha);
    expect(await countTasksAhead(project, 'workbench/auto', 'main')).toBe(0);
  });

  it('reports conflicts and leaves both branches as they were', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const wt = addTask('001-a', 'workbench/auto');
    commitFile(wt, 'a.txt', 'one\nTWO from the task\nthree\n', 'task work');
    expect((await autoMergeIntoTarget(mergeInput(wt, '001-a'))).success).toBe(true);
    commitFile(project, 'a.txt', 'one\nTWO from main\nthree\n', 'main edit');
    const mainBefore = git(project, 'rev-parse', 'main');
    const autoBefore = git(project, 'rev-parse', 'workbench/auto');

    const result = await mergeIntegrationIntoBase(project, 'workbench/auto', 'main');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.conflictedFiles).toEqual(['a.txt']);
    expect(git(project, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(project, 'rev-parse', 'workbench/auto')).toBe(autoBefore);
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  it('says so when there is nothing to merge', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    expect(await mergeIntegrationIntoBase(project, 'workbench/auto', 'main')).toMatchObject({ success: true, alreadyUpToDate: true });
  });
});

describe('advanceBranch', () => {
  it('refuses to move a branch that changed meanwhile', async () => {
    await ensureIntegrationBranch(project, 'workbench/auto', 'main');
    const start = (await localBranchSha(project, 'workbench/auto'))!;
    commitFile(project, 'x.txt', 'x\n', 'on main');
    const newer = git(project, 'rev-parse', 'main');
    git(project, 'update-ref', 'refs/heads/workbench/auto', newer);
    expect(await advanceBranch(project, 'workbench/auto', newer, start)).toMatch(/moved/);
  });
});
