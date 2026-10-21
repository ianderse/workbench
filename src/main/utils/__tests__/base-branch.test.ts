/**
 * A task keeps the base branch it was created with. When that branch is gone, the task must
 * still be startable: the base branch resolves to one that still exists, and a worktree can
 * only be created from a start point that git can resolve.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({
  getToolPath: () => 'git'
}));

import { branchExists, resolveBaseBranch } from '../base-branch';
import { getIsolatedGitEnv } from '../git-isolation';
import { createOrGetWorktree } from '../../worktree';

let tmp: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: getIsolatedGitEnv() }).trim();

function initRepo(): string {
  const repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, '.gitignore'), '.workbench/\n');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'base-branch-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('branchExists', () => {
  it('finds a local branch and misses one that was never created', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');

    expect(await branchExists(repo, 'develop')).toBe(true);
    expect(await branchExists(repo, 'gone')).toBe(false);
  });
});

describe('resolveBaseBranch', () => {
  it('keeps the branch the task asked for while it exists', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');

    expect(await resolveBaseBranch(repo, 'develop', ['main'])).toEqual({ branch: 'develop' });
  });

  it('stands in for a base branch that was deleted', async () => {
    const repo = initRepo();

    expect(await resolveBaseBranch(repo, 'develop', ['develop', 'main'])).toEqual({
      branch: 'main',
      missing: 'develop'
    });
  });

  it('leaves the branch alone when no fallback exists either', async () => {
    const repo = initRepo();

    expect(await resolveBaseBranch(repo, 'develop', ['release', undefined])).toEqual({ branch: 'develop' });
  });
});

describe('createOrGetWorktree with a missing base branch', () => {
  it('says which branch is missing instead of failing on an invalid reference', async () => {
    const repo = initRepo();

    await expect(createOrGetWorktree(repo, '014-task', 'develop', false, false))
      .rejects.toThrow(/Base branch "develop" does not exist/);
  });

  it('branches from the base branch that is there', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');
    writeFileSync(path.join(repo, 'README.md'), 'moved on\n');
    git(repo, 'commit', '-q', '-am', 'move main on');

    const worktree = await createOrGetWorktree(repo, '014-task', 'develop', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'develop'));
  });
});
