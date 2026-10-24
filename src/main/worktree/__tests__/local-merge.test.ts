/**
 * Merging a task's branch into its base branch locally (real git repos, fake merge agent):
 * - the merge happens in the project, on the base branch, and nothing is pushed
 * - a project on another branch, or with uncommitted changes, is left alone
 * - the base branch is pulled first when it tracks a remote; offline or diverged, a note says so
 * - conflicts are resolved by the merge agent in the task's worktree before the merge; a failed
 *   resolution leaves the worktree and the project as they were
 * - without `merge-tree --write-tree` (git < 2.38) the merge itself finds the conflicts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));
vi.mock('../../ai/runners/merge-agent', () => ({ runMergeAgent: vi.fn() }));

/** Set to make git act like a version without `merge-tree --write-tree` */
let oldGit = false;
vi.mock('../../utils/git-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/git-exec')>();
  return {
    ...actual,
    git: (args: string[], options: Parameters<typeof actual.git>[1]) =>
      oldGit && args.includes('merge-tree')
        ? Promise.reject(Object.assign(new Error('usage: git merge-tree'), { code: 129, stdout: '', stderr: 'usage: git merge-tree' }))
        : actual.git(args, options),
  };
});

import { localMerge, type LocalMergeConfig } from '../local-merge';
import type { MergeAgentFn, MergeAgentInput } from '../../ai/runners/merge-agent';

const BRANCH = 'workbench/001-a';

let tmp: string;
let project: string;
let worktree: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};

beforeEach(() => {
  oldGit = false;
  tmp = mkdtempSync(path.join(os.tmpdir(), 'local-merge-'));
  project = path.join(tmp, 'project');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'commit.gpgsign', 'false');
  git(project, 'config', 'core.autocrlf', 'false');
  commitFile(project, 'a.txt', 'one\ntwo\nthree\n', 'base');
  worktree = path.join(tmp, 'wt');
  git(project, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const config = (overrides: Partial<LocalMergeConfig> = {}): LocalMergeConfig => ({
  projectDir: project,
  worktreePath: worktree,
  targetBranch: 'main',
  ...overrides,
});

describe('localMerge', () => {
  it('merges the task branch into the base branch', async () => {
    commitFile(worktree, 'b.txt', 'from the task\n', 'task work');

    const result = await localMerge(config());

    expect(result).toMatchObject({ success: true, sourceBranch: BRANCH, targetBranch: 'main' });
    expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
    // Nothing was pushed: the project has no remote at all
    expect(git(project, 'remote')).toBe('');
  });

  it('reports a base branch that already has the task commits', async () => {
    const result = await localMerge(config());

    expect(result).toMatchObject({ success: true, alreadyMerged: true });
  });

  it('refuses when the project is on another branch', async () => {
    commitFile(worktree, 'b.txt', 'from the task\n', 'task work');
    git(project, 'checkout', '-q', '-b', 'other');

    const result = await localMerge(config());

    expect(result.success).toBe(false);
    expect(result.error).toContain('other');
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('other');
  });

  it('refuses when the worktree has uncommitted changes, ignoring Workbench files', async () => {
    commitFile(worktree, 'b.txt', 'from the task\n', 'task work');
    mkdirSync(path.join(worktree, '.workbench'), { recursive: true });
    writeFileSync(path.join(worktree, '.workbench', 'state.json'), '{}');
    git(worktree, 'add', '-A', '.workbench');

    expect((await localMerge(config())).success).toBe(true);

    writeFileSync(path.join(worktree, 'a.txt'), 'changed by hand\n');
    const result = await localMerge(config());

    expect(result.success).toBe(false);
    expect(result.error).toContain('uncommitted changes');
  });

  it('refuses when the project has uncommitted changes', async () => {
    commitFile(worktree, 'b.txt', 'from the task\n', 'task work');
    writeFileSync(path.join(project, 'a.txt'), 'changed by hand\n');

    const result = await localMerge(config());

    expect(result.success).toBe(false);
    expect(result.error).toContain('uncommitted changes');
  });

  it('merges without the merge agent when the branches do not conflict', async () => {
    commitFile(worktree, 'b.txt', 'from the task\n', 'task work');
    commitFile(project, 'c.txt', 'from the project\n', 'project work');
    const mergeAgent = vi.fn<MergeAgentFn>();
    const steps: string[] = [];

    const result = await localMerge(config({ mergeAgent, onProgress: (step) => steps.push(step) }));

    expect(result).toMatchObject({ success: true });
    expect(result.resolvedConflicts).toBeUndefined();
    expect(result.pullNote).toBeUndefined();
    expect(mergeAgent).not.toHaveBeenCalled();
    expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
    expect(steps).toEqual(['checking', 'checkingConflicts', 'merging']);
  });

  it('has the merge agent resolve conflicts in the worktree, then merges', async () => {
    commitFile(worktree, 'a.txt', 'one\ntask\nthree\n', 'task edit');
    commitFile(project, 'a.txt', 'one\nproject\nthree\n', 'project edit');
    const projectHead = git(project, 'rev-parse', 'HEAD');
    const mergeAgent = vi.fn<MergeAgentFn>(async (input: MergeAgentInput) => {
      expect(input).toMatchObject({
        worktreePath: worktree,
        branch: BRANCH,
        targetRef: 'main',
        conflictedFiles: ['a.txt'],
        taskTitle: 'Task A',
        verificationCommands: ['npm test'],
        profileId: 'profile-1',
      });
      // The project itself is not touched while the agent works
      expect(git(project, 'rev-parse', 'HEAD')).toBe(projectHead);
      expect(git(project, 'status', '--porcelain')).toBe('');
      writeFileSync(path.join(worktree, 'a.txt'), 'one\ntask\nproject\nthree\n');
      git(worktree, 'add', 'a.txt');
      git(worktree, 'commit', '-q', '--no-edit');
      return { status: 'resolved', summary: 'Kept both lines', intentionallyDropped: [] };
    });
    const steps: string[] = [];

    const result = await localMerge(config({
      mergeAgent,
      taskTitle: 'Task A',
      verificationCommands: ['npm test'],
      profileId: 'profile-1',
      onProgress: (step) => steps.push(step),
    }));

    expect(result).toMatchObject({ success: true, resolvedConflicts: ['a.txt'], summary: 'Kept both lines' });
    expect(mergeAgent).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(project, 'a.txt'), 'utf-8')).toBe('one\ntask\nproject\nthree\n');
    expect(git(project, 'rev-parse', 'main')).toBe(git(worktree, 'rev-parse', 'HEAD'));
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(steps).toEqual(['checking', 'checkingConflicts', 'resolving', 'verifying', 'merging']);
  });

  it('leaves the worktree and the project as they were when the agent cannot resolve the conflicts', async () => {
    commitFile(worktree, 'a.txt', 'one\ntask\nthree\n', 'task edit');
    commitFile(project, 'a.txt', 'one\nproject\nthree\n', 'project edit');
    const projectHead = git(project, 'rev-parse', 'HEAD');
    const worktreeHead = git(worktree, 'rev-parse', 'HEAD');
    const mergeAgent = vi.fn<MergeAgentFn>(async () => ({ status: 'failed', summary: 'Too risky', intentionallyDropped: [] }));

    const result = await localMerge(config({ mergeAgent }));

    expect(result).toMatchObject({ success: false, conflictedFiles: ['a.txt'], summary: 'Too risky' });
    expect(result.error).toContain('Too risky');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(worktreeHead);
    expect(() => git(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // The project is back on its own commit, with no merge in progress
    expect(git(project, 'rev-parse', 'HEAD')).toBe(projectHead);
    expect(readFileSync(path.join(project, 'a.txt'), 'utf-8')).toBe('one\nproject\nthree\n');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });

  it('finds conflicts with the merge itself when git has no merge-tree --write-tree', async () => {
    oldGit = true;
    commitFile(worktree, 'a.txt', 'one\ntask\nthree\n', 'task edit');
    commitFile(project, 'a.txt', 'one\nproject\nthree\n', 'project edit');
    const mergeAgent = vi.fn<MergeAgentFn>(async () => {
      // The attempt in the project was undone before the agent started
      expect(() => git(project, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
      writeFileSync(path.join(worktree, 'a.txt'), 'one\ntask\nproject\nthree\n');
      git(worktree, 'add', 'a.txt');
      git(worktree, 'commit', '-q', '--no-edit');
      return { status: 'resolved', summary: 'Kept both lines', intentionallyDropped: [] };
    });

    const result = await localMerge(config({ mergeAgent }));

    expect(result).toMatchObject({ success: true, resolvedConflicts: ['a.txt'] });
    expect(readFileSync(path.join(project, 'a.txt'), 'utf-8')).toBe('one\ntask\nproject\nthree\n');
  });

  it('merges a clean branch when git has no merge-tree --write-tree', async () => {
    oldGit = true;
    commitFile(worktree, 'b.txt', 'from the task\n', 'task work');
    const mergeAgent = vi.fn<MergeAgentFn>();

    expect(await localMerge(config({ mergeAgent }))).toMatchObject({ success: true });
    expect(mergeAgent).not.toHaveBeenCalled();
    expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
  });

  describe('with a remote', () => {
    let origin: string;
    let other: string;

    beforeEach(() => {
      origin = path.join(tmp, 'origin.git');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
      git(project, 'remote', 'add', 'origin', origin);
      git(project, 'push', '-q', '-u', 'origin', 'main');
      // Another clone stands for changes others pushed meanwhile
      other = path.join(tmp, 'other');
      git(tmp, 'clone', '-q', origin, other);
      git(other, 'config', 'user.email', 'test@example.com');
      git(other, 'config', 'user.name', 'Test');
      git(other, 'config', 'commit.gpgsign', 'false');
    });

    it('pulls the base branch before merging', async () => {
      commitFile(other, 'c.txt', 'pushed by someone else\n', 'remote work');
      git(other, 'push', '-q', 'origin', 'main');
      commitFile(worktree, 'b.txt', 'from the task\n', 'task work');
      const steps: string[] = [];

      const result = await localMerge(config({ mergeAgent: vi.fn<MergeAgentFn>(), onProgress: (step) => steps.push(step) }));

      expect(result.success).toBe(true);
      expect(result.pullNote).toBeUndefined();
      expect(readFileSync(path.join(project, 'c.txt'), 'utf-8')).toBe('pushed by someone else\n');
      expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
      expect(steps).toEqual(['checking', 'pulling', 'checkingConflicts', 'merging']);
      // Still nothing pushed
      expect(git(origin, 'log', '--format=%s', '-1', 'main')).toBe('remote work');
    });

    it('merges into the local base branch with a note when the remote cannot be reached', async () => {
      git(project, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
      commitFile(worktree, 'b.txt', 'from the task\n', 'task work');

      const result = await localMerge(config({ mergeAgent: vi.fn<MergeAgentFn>() }));

      expect(result).toMatchObject({ success: true, pullNote: { reason: 'fetchFailed', upstream: 'origin/main' } });
      expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
    });

    it('merges into the local base branch with a note when it diverged from the remote', async () => {
      commitFile(other, 'c.txt', 'pushed by someone else\n', 'remote work');
      git(other, 'push', '-q', 'origin', 'main');
      commitFile(project, 'd.txt', 'local only\n', 'local work');
      commitFile(worktree, 'b.txt', 'from the task\n', 'task work');

      const result = await localMerge(config({ mergeAgent: vi.fn<MergeAgentFn>() }));

      expect(result).toMatchObject({ success: true, pullNote: { reason: 'notFastForward', upstream: 'origin/main' } });
      expect(existsSync(path.join(project, 'c.txt'))).toBe(false);
      expect(readFileSync(path.join(project, 'b.txt'), 'utf-8')).toBe('from the task\n');
    });
  });
});
