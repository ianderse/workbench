/**
 * The resync service (real git repos): what it does with a task's pending request
 * - nothing when the branch already has the merge (the request is dropped)
 * - a note when the worktree has uncommitted changes (once; the request waits)
 * - a fast-forward when the task has no commits of its own
 * - starts the task, or queues it at the parallel task limit
 * - leaves failed requests, running tasks, branches being merged and local merges for PR tasks alone
 * - picks up a request when a run ends, but not when the user stopped it (at startup neither)
 * - checks a merge the task's session made itself before dropping the request
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));

import { TaskResync, type TaskResyncDeps } from '..';
import { readResyncRequest, recordResyncRequest, updateResyncRequest } from '../request';
import { clearStoppedByUser, markStoppedByUser } from '../user-stop';
import { guardKey, mergingPRs } from '../../worktree/merge-guard';
import { taskHooks } from '../../task-hooks';

let tmp: string;
let root: string;
let project: Project;
let tasks: Task[];
let running: Set<string>;
let atLimit: boolean;
let calls: string[];
let resync: TaskResync;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};
const worktreeOf = (specId: string) => path.join(root, '.workbench', 'worktrees', 'tasks', specId);
const specDirOf = (specId: string) => path.join(root, '.workbench', 'tasks', specId);

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: specId, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() };
}

/** A task in `status` with a worktree (with a commit of its own unless `work` is false) and a pending request for `main` */
function pending(specId: string, status: TaskStatus = 'human_review', work = true, metadata: Task['metadata'] = {}): Task {
  const dir = worktreeOf(specId);
  git(root, 'worktree', 'add', '-q', '-b', `workbench/${specId}`, dir, 'main');
  mkdirSync(specDirOf(specId), { recursive: true });
  if (work) commitFile(dir, `${specId}.txt`, 'work\n', `${specId} work`);
  const t = task(specId, status, metadata);
  tasks.push(t);
  return t;
}

function requestFor(specId: string, via: 'local' | 'pr' = 'local') {
  return recordResyncRequest(specDirOf(specId), { ref: 'main', into: 'main', via, merged: { specId: '001-a', title: 'A', files: ['c.txt'] } });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'task-resync-'));
  root = path.join(tmp, 'project');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  commitFile(root, 'a.txt', 'one\n', 'base');
  project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [];
  running = new Set();
  atLimit = false;
  calls = [];
  resync = new TaskResync();
  const deps: TaskResyncDeps = {
    getProject: () => project,
    getTasks: () => tasks,
    isRunning: (taskId) => running.has(taskId),
    isAtParallelLimit: () => atLimit,
    start: async (taskId) => { calls.push(`start ${taskId}`); },
    queue: async (_project, t) => { calls.push(`queue ${t.id}`); },
    note: async (_project, t, text) => { calls.push(`note ${t.id}: ${text}`); },
    runExclusive: (_projectId, fn) => fn(),
    delays: { afterRunMs: 0, retryMs: 5 },
  };
  resync.configure(deps);
});

afterEach(() => {
  resync.dispose();
  mergingPRs.clear();
  rmSync(tmp, { recursive: true, force: true });
});

const untilCalled = async (count = 1) => {
  for (let i = 0; i < 100 && calls.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

// Real git repos: git is slow to start on Windows runners
describe('TaskResync', { timeout: 30_000 }, () => {
  it('drops the request when the branch already has the merge', async () => {
    pending('002-b');
    requestFor('002-b');
    expect(await resync.process('p1', '002-b')).toBe('up-to-date');
    expect(readResyncRequest(specDirOf('002-b'))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('starts a task with work of its own, or queues it at the parallel task limit', async () => {
    pending('002-b');
    pending('003-c', 'error');
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    requestFor('002-b');
    requestFor('003-c');
    expect(await resync.process('p1', '002-b')).toBe('started');
    atLimit = true;
    expect(await resync.process('p1', '003-c')).toBe('queued');
    expect(calls).toEqual(['start 002-b', 'queue 003-c']);
    // The run applies (and clears) the request
    expect(readResyncRequest(specDirOf('002-b'))?.ref).toBe('main');
  });

  it('leaves a note once when the worktree has uncommitted changes, and keeps the request', async () => {
    pending('002-b');
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    writeFileSync(path.join(worktreeOf('002-b'), '002-b.txt'), 'uncommitted\n');
    requestFor('002-b');
    expect(await resync.process('p1', '002-b')).toBe('noted');
    expect(await resync.process('p1', '002-b')).toBe('noted');
    expect(calls).toEqual([expect.stringContaining('note 002-b: task 001-a "A" was merged into `main`, your base branch. Your worktree has uncommitted changes')]);
    expect(readResyncRequest(specDirOf('002-b'))?.notedAt).toBeDefined();
  });

  it('fast-forwards a task with no commits of its own', async () => {
    pending('002-b', 'error', false);
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    requestFor('002-b');
    expect(await resync.process('p1', '002-b')).toBe('fast-forwarded');
    expect(existsSync(path.join(worktreeOf('002-b'), 'c.txt'))).toBe(true);
    expect(readResyncRequest(specDirOf('002-b'))).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('leaves failed requests, running and in-progress tasks, and local merges for PR tasks alone', async () => {
    pending('002-b');
    pending('003-c', 'in_progress');
    pending('004-d', 'human_review', true, { prUrl: 'https://github.com/o/r/pull/4', prState: 'open' } as Task['metadata']);
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    const failed = requestFor('002-b');
    updateResyncRequest(specDirOf('002-b'), failed.at, { failedAt: new Date().toISOString(), error: 'x' });
    requestFor('003-c');
    requestFor('004-d');
    for (const id of ['002-b', '003-c', '004-d']) expect(await resync.process('p1', id)).toBe('none');
    expect(calls).toEqual([]);
  });

  it('waits while the run winds down or the branch is being merged', async () => {
    pending('002-b');
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    requestFor('002-b');
    running.add('002-b');
    expect(await resync.process('p1', '002-b')).toBe('retry');
    running.delete('002-b');
    mergingPRs.add(guardKey('p1', '002-b'));
    expect(await resync.process('p1', '002-b')).toBe('retry');
    // Another project's task of the same id being merged does not hold it
    mergingPRs.clear();
    mergingPRs.add(guardKey('p2', '002-b'));
    expect(await resync.process('p1', '002-b')).toBe('started');
  });

  it('applies a request a task got while running once its run ends, but not after the user stopped it', async () => {
    const b = pending('002-b');
    const c = pending('003-c');
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    requestFor('002-b');
    requestFor('003-c');
    // Stopped by the user: recorded before the task's state changes, while its run has not written
    // its "Stopped" phase yet
    markStoppedByUser(specDirOf('003-c'));
    writeFileSync(path.join(specDirOf('003-c'), 'claude_run.json'), JSON.stringify({ phases: [{ name: 'implement', endedAt: 'x' }] }));
    taskHooks.emit('state', { project, task: c, status: 'human_review' });
    taskHooks.emit('state', { project, task: b, status: 'human_review' });
    await untilCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual(['start 002-b']);
  });

  it('picks up requests left from before a restart, but not of a task the user stopped', async () => {
    pending('002-b');
    pending('003-c');
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    requestFor('002-b');
    requestFor('003-c');
    markStoppedByUser(specDirOf('003-c'));
    resync.scan(['p1']);
    await untilCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual(['start 002-b']);
    // Until the user starts it
    expect(await resync.process('p1', '003-c')).toBe('none');
    clearStoppedByUser(specDirOf('003-c'));
    expect(await resync.process('p1', '003-c')).toBe('started');
  });

  it("checks a merge the task's session made while it ran: drops the request when it holds, starts the task when it does not", async () => {
    const good = worktreeOf('002-b');
    const bad = worktreeOf('003-c');
    pending('002-b');
    pending('003-c');
    commitFile(good, 'a.txt', 'one\nfrom b\n', 'b changes a');
    commitFile(bad, 'a.txt', 'one\nfrom c\n', 'c changes a');
    commitFile(root, 'a.txt', 'one\nfrom main\nmore from main\n', 'a merged');
    requestFor('002-b');
    requestFor('003-c');
    // Each session merged main when it was told to; 003-c dropped main's lines
    for (const [dir, content] of [[good, 'one\nfrom b\nfrom main\nmore from main\n'], [bad, 'one\nfrom c\n']]) {
      try { git(dir, 'merge', '--no-edit', 'main'); } catch { /* conflicts */ }
      writeFileSync(path.join(dir, 'a.txt'), content);
      git(dir, 'commit', '-q', '-am', 'merge main');
    }

    expect(await resync.process('p1', '002-b')).toBe('up-to-date');
    expect(readResyncRequest(specDirOf('002-b'))).toBeUndefined();
    expect(await resync.process('p1', '003-c')).toBe('started');
    expect(readResyncRequest(specDirOf('003-c'))).toBeDefined();
    expect(calls).toEqual(['start 003-c']);
  });

  it('keeps a failure, and the local guard, when another merge coalesces into the request', async () => {
    pending('002-b');
    commitFile(root, 'c.txt', 'from a\n', 'a merged');
    const first = requestFor('002-b', 'local');
    updateResyncRequest(specDirOf('002-b'), first.at, { failedAt: new Date().toISOString(), error: 'x' });
    const next = recordResyncRequest(specDirOf('002-b'), { ref: 'origin/main', into: 'main', via: 'pr', merged: { specId: '005-e', files: [] } });
    expect(next).toEqual(expect.objectContaining({ ref: 'origin/main', refs: ['main', 'origin/main'], via: 'local', failedAt: expect.any(String) }));
    expect(await resync.process('p1', '002-b')).toBe('none');
    expect(calls).toEqual([]);
  });
});
