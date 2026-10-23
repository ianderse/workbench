/**
 * Merging a task's branch into its base branch locally (real git repos):
 * - the merge happens in the project, on the base branch, and nothing is pushed
 * - a project on another branch, or with uncommitted changes, is left alone
 * - a conflict is undone, so the project stays as it was
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: async () => 'git' }));

import { localMerge, type LocalMergeConfig } from '../local-merge';

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

  it('undoes a merge git cannot resolve and reports the conflicted files', async () => {
    commitFile(worktree, 'a.txt', 'one\ntask\nthree\n', 'task edit');
    commitFile(project, 'a.txt', 'one\nproject\nthree\n', 'project edit');

    const result = await localMerge(config());

    expect(result.success).toBe(false);
    expect(result.conflictedFiles).toEqual(['a.txt']);
    // The project is back on its own commit, with no merge in progress
    expect(readFileSync(path.join(project, 'a.txt'), 'utf-8')).toBe('one\nproject\nthree\n');
    expect(git(project, 'status', '--porcelain')).toBe('');
  });
});
