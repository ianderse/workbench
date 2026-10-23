/**
 * Hot paths that run several git commands per task share one launch in WSL (runToolScript,
 * one wsl.exe start), while native behavior stays as it was:
 * - the task changelog's branch changes (4 commands per state): one batch in WSL, parallel natively
 * - the worktree status polled for every task (3 commands): one batch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  wsl: true,
  runToolScript: vi.fn(),
  git: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  worktree: '/repo/.workbench/worktrees/tasks/001-a' as string | null,
}));

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/shell-runtime')>()),
  isWslRuntime: () => mocks.wsl,
}));
vi.mock('../platform/runtime-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/runtime-exec')>()),
  runToolScript: mocks.runToolScript,
}));
vi.mock('../utils/git-exec', () => ({ git: mocks.git }));
vi.mock('../worktree-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worktree-paths')>()),
  findTaskWorktree: () => mocks.worktree,
}));
vi.mock('../ipc-handlers/ipc-registry', () => ({
  handleIpc: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler),
}));
vi.mock('../ipc-handlers/task/shared', () => ({
  findTaskAndProject: () => ({
    task: { id: 't1', specId: '001-a' },
    project: { id: 'p1', path: '/repo', settings: { mainBranch: 'develop' } },
  }),
}));

import { taskHooks } from '../task-hooks';
import { flushTaskChangelog, registerTaskChangelog } from '../task-changelog-writer';
import { registerWorktreeHandlers } from '../ipc-handlers/task/worktree-handlers';
import { IPC_CHANNELS } from '../../shared/constants';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wsl = true;
});

describe('task changelog branch changes', () => {
  let tmp: string;
  let off: () => void;

  const run = async (status: string) => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'wsl-batching-'));
    off = registerTaskChangelog();
    const project = { id: 'p1', path: tmp, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
    const task = { id: 't1', specId: '001-a', title: 'A', metadata: {} } as unknown as Task;
    taskHooks.emit('state', { project, task, status: status as never, state: 'coding' } as never);
    await flushTaskChangelog();
    off();
    const content = readFileSync(path.join(tmp, '.workbench', 'changelog.jsonl'), 'utf-8');
    rmSync(tmp, { recursive: true, force: true });
    return JSON.parse(content.trim().split('\n').pop()!);
  };

  it('runs its 4 git commands in one WSL launch', async () => {
    mocks.runToolScript.mockResolvedValue([
      { code: 0, stdout: 'workbench/001-a\n', stderr: '' },
      { code: 0, stdout: 'src/a.ts\n', stderr: '' },
      { code: 0, stdout: 'src/b.ts\n.workbench/tasks/x.json\n', stderr: '' },
      { code: 128, stdout: 'ignored', stderr: 'fatal' },
    ]);
    const entry = await run('in_progress');
    expect(mocks.runToolScript).toHaveBeenCalledTimes(1);
    const [tool, invocations, options] = mocks.runToolScript.mock.calls[0];
    expect(tool).toBe('git');
    expect(invocations).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['diff', '--name-only', 'main...HEAD'],
      ['diff', '--name-only', 'HEAD'],
      ['ls-files', '--others', '--exclude-standard'],
    ]);
    expect(options.cwd).toBe(mocks.worktree);
    expect(mocks.git).not.toHaveBeenCalled();
    // A failed command adds nothing; the data dir is left out
    expect(entry).toMatchObject({ branch: 'workbench/001-a', files: ['src/a.ts', 'src/b.ts'] });
  });

  it('natively runs them as separate git calls, as before', async () => {
    mocks.wsl = false;
    mocks.git.mockResolvedValue({ stdout: '', stderr: '' });
    await run('human_review');
    expect(mocks.runToolScript).not.toHaveBeenCalled();
    expect(mocks.git).toHaveBeenCalledTimes(4);
  });
});

describe('worktree status', () => {
  it('reads branch, commit count and diff stats in one batch', async () => {
    registerWorktreeHandlers(() => null);
    mocks.runToolScript.mockResolvedValue([
      { code: 0, stdout: 'workbench/001-a\n', stderr: '' },
      { code: 0, stdout: '3\n', stderr: '' },
      { code: 0, stdout: ' 2 files changed, 10 insertions(+), 4 deletions(-)\n', stderr: '' },
    ]);
    const handler = mocks.handlers.get(IPC_CHANNELS.TASK_WORKTREE_STATUS)!;
    const result = await handler({}, 't1') as { data: Record<string, unknown> };

    expect(mocks.runToolScript).toHaveBeenCalledWith('git', [
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-list', '--count', 'develop..HEAD'],
      ['diff', '--stat', 'develop'],
    ], expect.objectContaining({ cwd: mocks.worktree }));
    expect(result.data).toMatchObject({
      exists: true, branch: 'workbench/001-a', baseBranch: 'develop', commitCount: 3, filesChanged: 2, additions: 10, deletions: 4,
    });
  });

  it('keeps the worktree when git fails there', async () => {
    registerWorktreeHandlers(() => null);
    mocks.runToolScript.mockResolvedValue([
      { code: 128, stdout: '', stderr: 'fatal: not a git repository' },
      { code: 128, stdout: '', stderr: '' },
      { code: 128, stdout: '', stderr: '' },
    ]);
    const handler = mocks.handlers.get(IPC_CHANNELS.TASK_WORKTREE_STATUS)!;
    const result = await handler({}, 't1') as { data: Record<string, unknown> };
    expect(result.data).toEqual({ exists: true, worktreePath: mocks.worktree });
  });
});
