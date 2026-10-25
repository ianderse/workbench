/**
 * Resync on auto-merge (real git repos): autonomous mode merging a task into its target branch
 * resyncs the other open tasks like a merge to Done does, against the target the tasks branch from,
 * and the same task moving to Done afterwards does not do it again.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));

import { configureTaskMessaging, resetTaskMessagingForTests } from '../broker';
import { announcesMergeOnDone, recordTaskMerge, takesInMerge } from '../merge-sync';
import { TaskNotices } from '../notices';
import { readResyncRequest } from '../../task-resync/request';

let tmp: string;
let root: string;
let project: Project;
let tasks: Task[];
let resyncs: string[];
let notices: TaskNotices;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};
const autoMeta = (branch: string, extra: object = {}) => ({ autoMerge: { sha: 'abc', branch, at: '2026-10-25T00:00:00Z', ...extra } }) as Task['metadata'];

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `T${specId.slice(0, 3)}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() } as Task;
}

const worktreeOf = (specId: string) => path.join(root, '.workbench', 'worktrees', 'tasks', specId);
const specDirOf = (specId: string) => path.join(root, '.workbench', 'tasks', specId);
const request = (specId: string) => readResyncRequest(specDirOf(specId));
function addWorktree(specId: string, from = 'main'): void {
  git(root, 'worktree', 'add', '-q', '-b', `workbench/${specId}`, worktreeOf(specId), from);
  mkdirSync(specDirOf(specId), { recursive: true });
  commitFile(worktreeOf(specId), `${specId}.txt`, 'work\n', `${specId} work`);
}
/** Task 001-a lands on the integration branch */
function landOnIntegration(): void {
  git(root, 'checkout', '-q', 'workbench/auto');
  commitFile(root, 'c.txt', 'from task a\n', 'task a auto-merged');
  git(root, 'checkout', '-q', 'main');
}
const autoMerged = async (into = 'workbench/auto') => {
  await notices.onAutoMerged({ project, task: tasks[0], into });
  await notices.flush();
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'merge-sync-auto-'));
  root = path.join(tmp, 'project');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  commitFile(root, 'a.txt', 'one\n', 'base');
  git(root, 'branch', 'workbench/auto', 'main');
  project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
  tasks = [task('001-a', 'human_review', autoMeta('workbench/auto'))];
  resyncs = [];
  configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
  // Autonomous mode with an integration branch: tasks branch from it, whatever base their metadata names (main)
  notices = new TaskNotices({
    batchMs: 60_000,
    editBatchMs: 60_000,
    requestResync: (_project, t) => resyncs.push(t.specId),
    autonomousTarget: () => 'workbench/auto',
  });
});

afterEach(() => {
  notices.stop();
  resetTaskMessagingForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('trigger rule', () => {
  it('takes in a merge into the branch the task is based on or branches from, never an auto-merged task', () => {
    const open = task('002-b', 'human_review');
    expect(takesInMerge(open, 'main', 'main')).toBe(true);
    expect(takesInMerge(open, 'main', 'workbench/auto', 'workbench/auto')).toBe(true);
    expect(takesInMerge(open, 'main', 'workbench/auto')).toBe(false);
    expect(takesInMerge(task('003-c', 'human_review', autoMeta('main')), 'main', 'main')).toBe(false);
    expect(takesInMerge(task('003-c', 'human_review', autoMeta('main', { revertedAt: 'x' })), 'main', 'main')).toBe(true);
  });

  it('announces a merge on Done unless autonomous mode merged the task already', () => {
    expect(announcesMergeOnDone(task('001-a', 'done'))).toBe(true);
    expect(announcesMergeOnDone(task('001-a', 'done', autoMeta('workbench/auto')))).toBe(false);
    expect(announcesMergeOnDone(task('001-a', 'done'), task('001-a', 'done', autoMeta('workbench/auto')))).toBe(false);
    expect(announcesMergeOnDone(task('001-a', 'done', autoMeta('workbench/auto', { revertedAt: 'x' })))).toBe(true);
  });
});

describe('resync on auto-merge', () => {
  it('asks the other open tasks to take the merge in, against the integration branch', async () => {
    tasks.push(task('002-b', 'human_review'), task('003-c', 'queue'));
    addWorktree('002-b');
    addWorktree('003-c');
    landOnIntegration();
    await autoMerged();

    expect(request('002-b')).toMatchObject({ ref: 'workbench/auto', into: 'workbench/auto', via: 'local' });
    expect(resyncs).toEqual(['002-b']);
    // Queued: its run applies the request when it starts
    expect(request('003-c')?.ref).toBe('workbench/auto');
  });

  it('leaves tasks that were auto-merged themselves, and merges into other branches, alone', async () => {
    tasks.push(task('002-b', 'human_review', autoMeta('workbench/auto')), task('003-c', 'human_review'));
    addWorktree('002-b');
    addWorktree('003-c');
    landOnIntegration();
    await autoMerged('release');
    expect(resyncs).toEqual([]);
    expect(request('003-c')).toBeUndefined();

    await autoMerged();
    expect(request('002-b')).toBeUndefined();
    expect(resyncs).toEqual(['003-c']);
  });

  it('does not resync again when the auto-merged task later moves to Done', async () => {
    tasks.push(task('002-b', 'human_review'));
    addWorktree('002-b');
    landOnIntegration();
    await autoMerged();
    expect(resyncs).toEqual(['002-b']);

    // A newer commit on the target would make a second trigger visible
    git(root, 'checkout', '-q', 'workbench/auto');
    commitFile(root, 'd.txt', 'later\n', 'later');
    git(root, 'checkout', '-q', 'main');
    recordTaskMerge('p1', '001-a', { into: 'workbench/auto', via: 'local' });
    await notices.onState({ project, task: { ...tasks[0], status: 'done' }, status: 'done' });
    await notices.flush();
    expect(resyncs).toEqual(['002-b']);
    expect(request('002-b')?.merged.map((t) => t.specId)).toEqual(['001-a']);
  });

  it('still resyncs on Done when the auto-merge was reverted', async () => {
    tasks[0] = task('001-a', 'human_review', autoMeta('main', { revertedAt: 'y' }));
    tasks.push(task('002-b', 'human_review'));
    addWorktree('002-b');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    recordTaskMerge('p1', '001-a', { into: 'main', via: 'local' });
    await notices.onState({ project, task: tasks[0], status: 'done' });
    await notices.flush();
    expect(resyncs).toEqual(['002-b']);
  });
});
