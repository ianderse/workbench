/**
 * Starting a task over saves its work on a backup branch first, and refuses to discard anything
 * when that fails. Runs against a real repo and a real worktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({
  getToolPath: () => 'git',
  getToolPathAsync: async () => 'git'
}));

import { backupTaskWork } from '../task-work-backup';
import { discardTaskWorktree } from '../worktree-cleanup';
import { getIsolatedGitEnv } from '../git-isolation';

const SPEC = '001-feature';
let tmp: string;
let repo: string;
let wt: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: getIsolatedGitEnv() }).trim();

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'wb-backup-'));
  repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, '.gitignore'), '.workbench/\n');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  wt = path.join(repo, '.workbench/worktrees/tasks', SPEC);
  mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', `workbench/${SPEC}`, wt, 'main');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const backupBranches = (): string[] =>
  git(repo, 'branch', '--list', 'workbench/backup/*', '--format=%(refname:short)').split('\n').filter(Boolean);

describe('backupTaskWork', () => {
  it('has nothing to save for an untouched worktree', async () => {
    const result = await backupTaskWork(repo, SPEC);
    expect(result.status).toBe('nothing');
    expect(backupBranches()).toEqual([]);
  });

  it('saves committed, uncommitted and untracked work, and leaves generated folders out', async () => {
    writeFileSync(path.join(wt, 'committed.ts'), 'committed\n');
    git(wt, 'add', 'committed.ts');
    git(wt, 'commit', '-q', '-m', 'work');
    writeFileSync(path.join(wt, 'README.md'), 'changed\n');
    mkdirSync(path.join(wt, 'src'));
    writeFileSync(path.join(wt, 'src/new.ts'), 'untracked\n');
    mkdirSync(path.join(wt, 'node_modules/pkg'), { recursive: true });
    writeFileSync(path.join(wt, 'node_modules/pkg/index.js'), 'dep\n');

    const result = await backupTaskWork(repo, SPEC);
    expect(result.status).toBe('saved');
    expect(result.branch).toMatch(new RegExp(`^workbench/backup/${SPEC}-\\d{8}-\\d{6}$`));

    const files = git(repo, 'ls-tree', '-r', '--name-only', result.branch!).split('\n');
    expect(files).toContain('committed.ts');
    expect(files).toContain('src/new.ts');
    expect(git(repo, 'show', `${result.branch}:README.md`)).toBe('changed');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    // The main checkout is untouched
    expect(git(repo, 'rev-parse', 'main')).not.toBe(git(repo, 'rev-parse', result.branch!));
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('saves only uncommitted work too', async () => {
    writeFileSync(path.join(wt, 'only-dirty.ts'), 'x\n');
    const result = await backupTaskWork(repo, SPEC);
    expect(result.status).toBe('saved');
    expect(git(repo, 'ls-tree', '-r', '--name-only', result.branch!)).toContain('only-dirty.ts');
  });

  it('fails (and says so) when the backup cannot be made', async () => {
    writeFileSync(path.join(wt, 'work.ts'), 'x\n');
    // A hook-less repo cannot fail a commit easily: break the index instead
    writeFileSync(path.join(git(wt, 'rev-parse', '--absolute-git-dir'), 'index.lock'), '');
    const result = await backupTaskWork(repo, SPEC);
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});

describe('discardTaskWorktree', () => {
  it('keeps the work on a backup branch and removes the worktree and task branch', async () => {
    writeFileSync(path.join(wt, 'precious.ts'), 'precious\n');
    const result = await discardTaskWorktree(repo, SPEC);
    expect(result.success).toBe(true);
    expect(result.backupBranch).toBeTruthy();
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', `workbench/${SPEC}`)).toBe('');
    expect(git(repo, 'ls-tree', '-r', '--name-only', result.backupBranch!)).toContain('precious.ts');
  });

  it('aborts without discarding anything when the backup fails', async () => {
    writeFileSync(path.join(wt, 'precious.ts'), 'precious\n');
    writeFileSync(path.join(git(wt, 'rev-parse', '--absolute-git-dir'), 'index.lock'), '');
    const result = await discardTaskWorktree(repo, SPEC);
    expect(result.success).toBe(false);
    expect(existsSync(path.join(wt, 'precious.ts'))).toBe(true);
    expect(git(repo, 'branch', '--list', `workbench/${SPEC}`)).not.toBe('');
  });
});
