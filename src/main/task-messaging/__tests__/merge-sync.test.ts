/**
 * After a task is merged (real git repos):
 * - every other unfinished task hears about it (In Progress, AI Review, Human Review, PR Created,
 *   Error), whatever files it changes; planned, done and archived tasks don't
 * - running tasks on the same base branch are told to merge it now, and keep a resync request in
 *   case their run ends without doing it
 * - tasks that don't run get a resync request (coalesced over merges) and are handed to the
 *   resync service; queued (rate-limited) ones keep the request for when they resume
 * - branches that already have the merge, and branches being merged, are left alone
 * - a merged pull request is read from `origin/<base>` after a fetch (the local branch when the
 *   fetch fails)
 * - a local merge (not pushed) is kept out of tasks with a pull request: a notice only
 * - tasks on another base branch get an informational notice only
 * - requests are recorded while notices are off too
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));

/** Concurrent `git merge --no-edit` calls, to check that pulls run one at a time */
const merges = { active: 0, max: 0, delayMs: 0, onGit: undefined as ((args: string[]) => void) | undefined };
vi.mock('../../utils/git-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/git-exec')>();
  return {
    ...actual,
    git: async (args: string[], options: Parameters<typeof actual.git>[1]) => {
      merges.onGit?.(args);
      if (args[0] !== 'merge' || args[1] !== '--no-edit') return actual.git(args, options);
      merges.active++;
      merges.max = Math.max(merges.max, merges.active);
      try {
        if (merges.delayMs) await new Promise((resolve) => setTimeout(resolve, merges.delayMs));
        return await actual.git(args, options);
      } finally {
        merges.active--;
      }
    },
  };
});

import { configureTaskMessaging, resetTaskMessagingForTests, takeInbox } from '../broker';
import { isBranchMergedInto, recordTaskMerge } from '../merge-sync';
import { TaskNotices } from '../notices';
import { guardKey, localMerges } from '../../worktree/merge-guard';
import { readResyncRequest } from '../../task-resync/request';
import { markStoppedByUser } from '../../task-resync/user-stop';

let tmp: string;
let root: string;
let project: Project;
let tasks: Task[];
let running: Set<string>;
let resyncs: string[];
let notices: TaskNotices;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const configure = (repo: string) => {
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
};
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}, extra: Partial<Task> = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `T${specId.slice(0, 3)}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date(), ...extra };
}

const worktreeOf = (specId: string) => path.join(root, '.workbench', 'worktrees', 'tasks', specId);
const specDirOf = (specId: string) => path.join(root, '.workbench', 'tasks', specId);
function addWorktree(specId: string, work = true): string {
  const dir = worktreeOf(specId);
  git(root, 'worktree', 'add', '-q', '-b', `workbench/${specId}`, dir, 'main');
  mkdirSync(specDirOf(specId), { recursive: true });
  if (work) commitFile(dir, `${specId}.txt`, 'work\n', `${specId} work`);
  return dir;
}
const texts = async (specId: string) => (await takeInbox('p1', specId)).map((m) => m.text);
const request = (specId: string) => readResyncRequest(specDirOf(specId));

/** Task 001-a was merged into `into` */
async function merged(via: 'local' | 'pr' = 'local', into = 'main', on: TaskNotices = notices): Promise<void> {
  recordTaskMerge('p1', '001-a', { into, via });
  await on.onState({ project, task: tasks[0], status: 'done' });
  await on.flush();
}

beforeEach(() => {
  merges.active = 0;
  merges.max = 0;
  merges.delayMs = 0;
  merges.onGit = undefined;
  tmp = mkdtempSync(path.join(os.tmpdir(), 'merge-sync-'));
  root = path.join(tmp, 'project');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  configure(root);
  commitFile(root, 'a.txt', 'one\ntwo\nthree\n', 'base');
  project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
  tasks = [task('001-a', 'human_review')];
  running = new Set();
  resyncs = [];
  configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
  notices = new TaskNotices({
    batchMs: 60_000,
    editBatchMs: 60_000,
    isRunning: (_projectId, t) => running.has(t.specId),
    requestResync: (_project, t) => resyncs.push(t.specId),
  });
});

afterEach(() => {
  notices.stop();
  localMerges.clear();
  resetTaskMessagingForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('merge sync', () => {
  it('tells every unfinished task about a merge, whatever files it changes', async () => {
    const statuses: TaskStatus[] = ['in_progress', 'ai_review', 'human_review', 'human_review', 'pr_created', 'error', 'queue', 'backlog', 'done', 'human_review'];
    tasks.push(...statuses.map((status, i) => task(`0${10 + i}-x`, status, {
      baseBranch: 'dev',
      ...(i === 3 ? { reviewReason: 'stopped' } : {}),
      ...(i === 9 ? { archivedAt: '2026-10-01T00:00:00Z' } : {}),
    } as Task['metadata'])));
    await merged();

    const told: string[] = [];
    for (const t of tasks.slice(1)) if ((await texts(t.specId)).length > 0) told.push(t.status);
    expect(told).toEqual(['in_progress', 'ai_review', 'human_review', 'human_review', 'pr_created', 'error']);
    const [notice] = await texts('010-x');
    expect(notice).toContain('was merged into `main`. That is not your base branch (`dev`), so there is nothing to pull.');
    expect(resyncs).toEqual([]);
  });

  it('tells a running task on the same base branch to merge it now', async () => {
    mkdirSync(path.join(root, '.workbench'), { recursive: true });
    writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'),
      JSON.stringify({ at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'human_review', files: ['src/a.ts'] }));
    tasks.push(task('002-b', 'in_progress'), task('003-c', 'human_review'));
    running.add('003-c');
    await merged();

    for (const specId of ['002-b', '003-c']) {
      const [notice] = await texts(specId);
      expect(notice).toMatch(/^Task 001-a "T001" \(session wb-[a-z0-9]{6}-001-a\) was merged into `main`, your base branch\. It changed `src\/a\.ts`\./);
      expect(notice).toContain('Merge it into your branch now: commit your work in progress, run `git merge --no-edit main`');
      expect(notice).toContain('If you are in a read-only planning step, do this at the start of implementation.');
    }
    expect(resyncs).toEqual([]);
  });

  it('records a resync request for a task that does not run and hands it to the resync service, without touching its worktree', async () => {
    mkdirSync(path.join(root, '.workbench'), { recursive: true });
    writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'),
      JSON.stringify({ at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'human_review', files: ['c.txt'] }));
    tasks.push(task('002-b', 'human_review', { reviewReason: 'completed' } as Task['metadata']), task('003-c', 'error'));
    const heads = ['002-b', '003-c'].map((specId) => git(addWorktree(specId), 'rev-parse', 'HEAD'));
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged();

    expect(resyncs).toEqual(['002-b', '003-c']);
    expect(request('002-b')).toEqual(expect.objectContaining({
      ref: 'main', into: 'main', via: 'local', merged: [{ specId: '001-a', title: 'T001', files: ['c.txt'] }],
    }));
    expect(['002-b', '003-c'].map((specId) => git(worktreeOf(specId), 'rev-parse', 'HEAD'))).toEqual(heads);
    expect(merges.max).toBe(0);
    // The notice is the resync itself
    expect(await texts('002-b')).toEqual([]);
  });

  it('keeps the request of a running task for when its run ends, and of a queued task for when it resumes', async () => {
    tasks.push(task('002-b', 'in_progress'), task('003-c', 'queue', {}, { rateLimitHold: { resetAt: '2026-10-25T00:00:00Z', message: 'limit' } } as Partial<Task>));
    addWorktree('002-b');
    addWorktree('003-c');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged();

    expect(request('002-b')?.ref).toBe('main');
    expect(request('003-c')?.ref).toBe('main');
    expect(resyncs).toEqual([]);
    expect(await texts('002-b')).toEqual([expect.stringContaining('Merge it into your branch now')]);
    expect(await texts('003-c')).toEqual([]);
  });

  it('coalesces merges into one request for the latest ref', async () => {
    tasks.push(task('002-b', 'human_review'), task('009-z', 'done'));
    addWorktree('002-b');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged();
    const first = request('002-b')!;
    // Another task merged into main before 002-b got to it
    commitFile(root, 'd.txt', 'from task z\n', 'task z merged');
    recordTaskMerge('p1', '009-z', { into: 'main', via: 'local' });
    await notices.onState({ project, task: tasks[2], status: 'done' });
    await notices.flush();

    const second = request('002-b')!;
    expect(second.merged.map((t) => t.specId)).toEqual(['001-a', '009-z']);
    expect(Date.parse(second.at)).toBeGreaterThanOrEqual(Date.parse(first.at));
    expect(resyncs).toEqual(['002-b', '002-b']);
  });

  it('leaves branches that already have the merge, and branches being merged, alone', async () => {
    tasks.push(task('002-b', 'human_review'), task('003-c', 'human_review'));
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    // 002-b is created from main after the merge: already up to date
    addWorktree('002-b');
    addWorktree('003-c');
    git(worktreeOf('003-c'), 'reset', '-q', '--hard', 'HEAD~2');
    commitFile(worktreeOf('003-c'), 'x.txt', 'x\n', 'own');
    localMerges.add(guardKey('p1', '003-c'));
    // Another project's task of the same id being merged does not count
    localMerges.add(guardKey('p2', '002-b'));
    await merged();

    expect(request('002-b')).toBeUndefined();
    expect(request('003-c')).toBeUndefined();
    expect(resyncs).toEqual([]);
  });

  it('reads a merged pull request from origin/<base> after fetching it, also for a task with a pull request', async () => {
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'clone', '-q', '--bare', root, origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'fetch', '-q', 'origin');
    tasks.push(task('002-b', 'human_review'), task('003-c', 'pr_created', { prUrl: 'https://github.com/o/r/pull/3', prState: 'open' } as Task['metadata']));
    addWorktree('002-b');
    addWorktree('003-c');
    // The PR was merged on the remote; the project's own main doesn't have it
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', origin, other);
    configure(other);
    commitFile(other, 'pr.txt', 'from the pull request\n', 'merge pull request');
    git(other, 'push', '-q', 'origin', 'main');
    await merged('pr');

    expect(request('002-b')).toEqual(expect.objectContaining({ ref: 'origin/main', into: 'main', via: 'pr' }));
    expect(request('003-c')?.ref).toBe('origin/main');
    expect(resyncs).toEqual(['002-b', '003-c']);
    expect(existsSync(path.join(root, 'pr.txt'))).toBe(false);
  });

  it('keeps a local merge out of tasks with a pull request, and tells them why', async () => {
    tasks.push(task('002-b', 'pr_created'), task('003-c', 'human_review', { prUrl: 'https://github.com/o/r/pull/3', prState: 'open' } as Task['metadata']));
    for (const specId of ['002-b', '003-c']) addWorktree(specId);
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged();

    expect(resyncs).toEqual([]);
    for (const specId of ['002-b', '003-c']) {
      expect(request(specId)).toBeUndefined();
      expect(await texts(specId)).toEqual([expect.stringMatching(
        /^Task 001-a "T001" \(session wb-[a-z0-9]{6}-001-a\) was merged into `main` locally and is not pushed yet, so it was not merged into your branch: your pull request merges against `origin\/main`\.$/)]);
    }
  });

  it('keeps a local merge out of a task that got a pull request while it waited', async () => {
    tasks.push(task('002-b', 'human_review'), task('003-c', 'human_review'));
    for (const specId of ['002-b', '003-c']) addWorktree(specId);
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    // 003-c's pull request is created while 002-b is checked
    merges.onGit = (args) => {
      if (args[0] === 'merge-base') tasks[2].metadata = { prUrl: 'https://github.com/o/r/pull/3' } as Task['metadata'];
    };
    await merged();

    expect(resyncs).toEqual(['002-b']);
    expect(request('003-c')).toBeUndefined();
    expect(await texts('003-c')).toEqual([expect.stringContaining('locally and is not pushed yet')]);
  });

  it('falls back to the local branch when the fetch fails, and says so', async () => {
    tasks.push(task('002-b', 'in_progress'));
    await merged('pr');
    const [notice] = await texts('002-b');
    expect(notice).toContain('run `git merge --no-edit main`');
    expect(notice).toContain('Workbench could not fetch `origin/main`, so this is your local `main`');
  });

  it('tells a task that started while its worktree was checked to merge it itself', async () => {
    tasks.push(task('002-b', 'human_review'));
    addWorktree('002-b');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    merges.onGit = (args) => {
      if (args[0] === 'merge-base') running.add('002-b');
    };
    await merged();

    expect(resyncs).toEqual([]);
    expect(request('002-b')?.ref).toBe('main');
    expect(await texts('002-b')).toEqual([expect.stringContaining('Merge it into your branch now')]);
  });

  it('records requests while task messaging notices are off, without sending notices', async () => {
    const off = new TaskNotices({ batchMs: 60_000, isEnabled: () => false, requestResync: (_project, t) => resyncs.push(t.specId), isRunning: (_p, t) => running.has(t.specId) });
    tasks.push(task('002-b', 'human_review'), task('003-c', 'in_progress'));
    addWorktree('002-b');
    addWorktree('003-c');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged('local', 'main', off);
    off.stop();

    expect(resyncs).toEqual(['002-b']);
    expect(request('003-c')?.ref).toBe('main');
    expect(await texts('003-c')).toEqual([]);
  });

  it('treats a merged pull request it could not fetch as a local merge: kept out of tasks with a pull request', async () => {
    tasks.push(task('002-b', 'human_review'), task('003-c', 'pr_created'));
    for (const specId of ['002-b', '003-c']) addWorktree(specId);
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    // No origin: the fetch fails, and the local `main` (with its unpushed commits) stands in
    await merged('pr');

    expect(request('002-b')).toEqual(expect.objectContaining({ ref: 'main', via: 'local' }));
    expect(request('003-c')).toBeUndefined();
    expect(await texts('003-c')).toEqual([expect.stringContaining('Workbench could not fetch it, so it was not merged into your branch')]);
  });

  it('takes a branch as merged only when it has commits of its own that its base branch has', async () => {
    const dir = addWorktree('002-b', false);
    // No commits: in main without having been merged; edits alone change nothing
    writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
    expect(await isBranchMergedInto(root, 'workbench/002-b', 'main')).toBe(false);
    git(dir, 'checkout', '-q', '--', 'a.txt');
    commitFile(dir, 'b.txt', 'work\n', 'work');
    expect(await isBranchMergedInto(root, 'workbench/002-b', 'main')).toBe(false);
    git(root, 'merge', '-q', '--no-edit', 'workbench/002-b');
    expect(await isBranchMergedInto(root, 'workbench/002-b', 'main')).toBe(true);
    expect(await isBranchMergedInto(root, 'workbench/missing', 'main')).toBe(false);
  });

  it('announces a merge made outside Workbench when the branch is gone by the time the task enters Done', async () => {
    const outside = new TaskNotices({
      batchMs: 60_000,
      requestResync: (_project, t) => resyncs.push(t.specId),
      isMerged: async (p, _t, branch, base) => !!branch && isBranchMergedInto(p.path, branch, base),
    });
    const dir = addWorktree('001-a');
    tasks.push(task('002-b', 'human_review'));
    addWorktree('002-b');
    mkdirSync(path.join(root, '.workbench'), { recursive: true });
    writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), JSON.stringify({ at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'human_review', files: ['001-a.txt'] }));
    git(root, 'merge', '-q', '--no-edit', 'workbench/001-a');
    // The board's Done flow: checked first, then the worktree and branch are deleted
    await outside.noteMergeBeforeDone(project, tasks[0]);
    git(root, 'worktree', 'remove', '--force', dir);
    git(root, 'branch', '-D', 'workbench/001-a');
    await outside.onState({ project, task: tasks[0], status: 'done' });
    await outside.flush();
    outside.stop();

    expect(resyncs).toEqual(['002-b']);
    expect(request('002-b')).toEqual(expect.objectContaining({ ref: 'main', via: 'local' }));
  });

  it('does not announce a stopped task as finished before its run writes the stop', async () => {
    tasks.push(task('002-b', 'in_progress'));
    mkdirSync(path.join(root, '.workbench'), { recursive: true });
    writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), [
      { at: '2026-10-01T00:00:00Z', task: '001-a', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
      { at: '2026-10-01T00:00:01Z', task: '002-b', event: 'state', status: 'in_progress', files: ['src/x.ts'] },
    ].map((e) => JSON.stringify(e)).join('\n'));
    mkdirSync(specDirOf('001-a'), { recursive: true });
    writeFileSync(path.join(specDirOf('001-a'), 'claude_run.json'), JSON.stringify({ phases: [{ name: 'implement', endedAt: 'x' }], summary: 'Half done' }));
    markStoppedByUser(specDirOf('001-a'));
    await notices.onState({ project, task: tasks[0], status: 'in_progress', state: 'coding' });
    await notices.onState({ project, task: tasks[0], status: 'human_review', state: 'human_review' });
    await notices.flush();

    expect(await texts('002-b')).toEqual([]);
  });
});
