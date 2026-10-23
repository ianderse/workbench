/**
 * The project's worktrees from `git worktree list --porcelain`: when git runs in WSL it lists
 * Linux paths, which come back as host paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const refs = vi.hoisted(() => ({ porcelain: '', root: '', wsl: false }));

vi.mock('../../utils/git-exec', () => ({
  git: vi.fn(async () => ({ stdout: refs.porcelain, stderr: '' })),
}));
vi.mock('../../platform/shell-runtime', async () => {
  const { join } = await import('path');
  return {
    // The distribution sees the temp folder as /mnt/host
    toHostPath: (p: string) => {
      const rest = refs.wsl ? /^\/mnt\/host(\/.*)?$/.exec(p) : null;
      return rest ? join(refs.root, rest[1] ?? '') : p;
    },
  };
});

import { listWorktrees } from '../project-setup';

describe('listWorktrees', () => {
  beforeEach(() => {
    refs.root = mkdtempSync(path.join(tmpdir(), 'wt-list-'));
    mkdirSync(path.join(refs.root, 'project'));
    mkdirSync(path.join(refs.root, 'project-wt'));
    refs.wsl = false;
  });

  afterEach(() => {
    rmSync(refs.root, { recursive: true, force: true });
  });

  it('lists the worktrees besides the project', async () => {
    refs.porcelain = [
      `worktree ${path.join(refs.root, 'project')}`, 'HEAD abc', 'branch refs/heads/main', '',
      `worktree ${path.join(refs.root, 'project-wt')}`, 'HEAD def', 'branch refs/heads/task', '',
    ].join('\n');
    expect(await listWorktrees(path.join(refs.root, 'project'))).toEqual([path.join(refs.root, 'project-wt')]);
  });

  it('turns the Linux paths git lists in WSL into host paths', async () => {
    refs.wsl = true;
    refs.porcelain = [
      'worktree /mnt/host/project', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree /mnt/host/project-wt', 'HEAD def', 'branch refs/heads/task', '',
    ].join('\n');
    expect(await listWorktrees(path.join(refs.root, 'project'))).toEqual([path.join(refs.root, 'project-wt')]);
  });
});
