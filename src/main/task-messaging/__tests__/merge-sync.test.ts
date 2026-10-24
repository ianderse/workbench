/**
 * After a task is merged (real git repos):
 * - every other unfinished task hears about it (In Progress, AI Review, Human Review, PR Created,
 *   Error), whatever files it changes; queued, planned, done and archived tasks don't
 * - running tasks on the same base branch are told to merge it now
 * - tasks that don't run get it merged into their worktree by Workbench: clean merges are noted,
 *   conflicts are undone and noted, dirty worktrees and busy branches are left alone
 * - a merged pull request is read from `origin/<base>` after a fetch (the local branch when the
 *   fetch fails)
 * - tasks on another base branch get an informational notice only
 * - pulls run one at a time per project
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
import { recordTaskMerge } from '../merge-sync';
import { TaskNotices, onTaskLifecycle, type TaskLifecycleEvent } from '../notices';
import { localMerges } from '../../worktree/merge-guard';

let tmp: string;
let root: string;
let project: Project;
let tasks: Task[];
let running: Set<string>;
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

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `T${specId.slice(0, 3)}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() };
}

const worktreeOf = (specId: string) => path.join(root, '.workbench', 'worktrees', 'tasks', specId);
const specDirOf = (specId: string) => path.join(root, '.workbench', 'tasks', specId);
function addWorktree(specId: string): string {
  const dir = worktreeOf(specId);
  git(root, 'worktree', 'add', '-q', '-b', `workbench/${specId}`, dir, 'main');
  return dir;
}
const texts = async (specId: string) => (await takeInbox('p1', specId)).map((m) => m.text);
const logEntries = (specId: string): string[] => {
  const file = path.join(specDirOf(specId), 'task_logs.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf-8')) as { phases: { coding: { entries: Array<{ content: string }> } } }).phases.coding.entries.map((e) => e.content);
};

/** Task 001-a was merged into `into` */
async function merged(via: 'local' | 'pr' = 'local', into = 'main'): Promise<void> {
  recordTaskMerge('p1', '001-a', { into, via });
  await notices.onState({ project, task: tasks[0], status: 'done' });
  await notices.flush();
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
  configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
  notices = new TaskNotices({ batchMs: 60_000, editBatchMs: 60_000, isRunning: (_projectId, t) => running.has(t.specId) });
});

afterEach(() => {
  notices.stop();
  localMerges.clear();
  resetTaskMessagingForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('merge sync', () => {
  it('tells every unfinished task about a merge, whatever files it changes, and emits the merge for the lead', async () => {
    const statuses: TaskStatus[] = ['in_progress', 'ai_review', 'human_review', 'human_review', 'pr_created', 'error', 'queue', 'backlog', 'done', 'human_review'];
    tasks.push(...statuses.map((status, i) => task(`0${10 + i}-x`, status, {
      baseBranch: 'dev',
      ...(i === 3 ? { reviewReason: 'stopped' } : {}),
      ...(i === 9 ? { archivedAt: '2026-10-01T00:00:00Z' } : {}),
    } as Task['metadata'])));
    const events: TaskLifecycleEvent[] = [];
    const off = onTaskLifecycle((event) => events.push(event));
    await merged();
    off();

    const told: string[] = [];
    for (const t of tasks.slice(1)) if ((await texts(t.specId)).length > 0) told.push(t.status);
    expect(told).toEqual(['in_progress', 'ai_review', 'human_review', 'human_review', 'pr_created', 'error']);
    const [notice] = await texts('010-x');
    expect(notice).toContain('was merged into `main`. That is not your base branch (`dev`), so there is nothing to pull.');
    expect(events).toEqual([expect.objectContaining({ kind: 'merged', specId: '001-a', baseBranch: 'main', mergedVia: 'local' })]);
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
  });

  it('merges the branch into a task that does not run, and notes it', async () => {
    tasks.push(task('002-b', 'human_review', { reviewReason: 'completed' } as Task['metadata']));
    mkdirSync(specDirOf('002-b'), { recursive: true });
    const wt = addWorktree('002-b');
    commitFile(wt, 'b.txt', 'task b\n', 'task b work');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged();

    expect(readFileSync(path.join(wt, 'c.txt'), 'utf-8')).toBe('from task a\n');
    expect(git(wt, 'log', '-1', '--format=%s')).toMatch(/^Merge branch 'main'/);
    expect(await texts('002-b')).toEqual([expect.stringMatching(/^`main` was merged into your branch after task 001-a "T001" was merged into it\./)]);
    expect(logEntries('002-b')).toEqual([expect.stringContaining('Merged main into this task\'s branch after task 001-a')]);
  });

  it('undoes a conflicting merge and leaves a note for the task', async () => {
    tasks.push(task('002-b', 'error'));
    mkdirSync(specDirOf('002-b'), { recursive: true });
    const wt = addWorktree('002-b');
    commitFile(wt, 'a.txt', 'one\nTASK B\nthree\n', 'task b work');
    const head = git(wt, 'rev-parse', 'HEAD');
    commitFile(root, 'a.txt', 'one\nTASK A\nthree\n', 'task a merged');
    await merged();

    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(wt, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(() => git(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    const [note] = await texts('002-b');
    expect(note).toContain('It conflicts with your branch in `a.txt`, so Workbench did not merge it; the conflicts will be resolved when this task is merged.');
    expect(logEntries('002-b')).toEqual([expect.stringContaining('conflicts with main in a.txt; they will be resolved when this task is merged')]);
  });

  it('leaves a dirty worktree alone, does nothing when up to date, and skips a branch being merged', async () => {
    tasks.push(task('002-b', 'human_review'), task('003-c', 'pr_created'), task('004-d', 'human_review'));
    for (const specId of ['002-b', '003-c', '004-d']) mkdirSync(specDirOf(specId), { recursive: true });
    const dirty = addWorktree('002-b');
    writeFileSync(path.join(dirty, 'a.txt'), 'uncommitted\n');
    const dirtyHead = git(dirty, 'rev-parse', 'HEAD');
    const busy = addWorktree('004-d');
    const busyHead = git(busy, 'rev-parse', 'HEAD');
    localMerges.add('004-d');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    // 003-c is created from main after the merge: already up to date
    addWorktree('003-c');
    await merged();

    expect(git(dirty, 'rev-parse', 'HEAD')).toBe(dirtyHead);
    expect(readFileSync(path.join(dirty, 'a.txt'), 'utf-8')).toBe('uncommitted\n');
    expect(await texts('002-b')).toEqual([expect.stringContaining('Your worktree has uncommitted changes, so Workbench did not merge it')]);
    expect(await texts('003-c')).toEqual([]);
    expect(git(busy, 'rev-parse', 'HEAD')).toBe(busyHead);
    expect(await texts('004-d')).toEqual([]);
  });

  it('reads a merged pull request from origin/<base> after fetching it', async () => {
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'clone', '-q', '--bare', root, origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'fetch', '-q', 'origin');
    tasks.push(task('002-b', 'human_review'));
    mkdirSync(specDirOf('002-b'), { recursive: true });
    const wt = addWorktree('002-b');
    // The PR was merged on the remote; the project's own main doesn't have it
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', origin, other);
    configure(other);
    commitFile(other, 'pr.txt', 'from the pull request\n', 'merge pull request');
    git(other, 'push', '-q', 'origin', 'main');
    await merged('pr');

    expect(readFileSync(path.join(wt, 'pr.txt'), 'utf-8')).toBe('from the pull request\n');
    expect(existsSync(path.join(root, 'pr.txt'))).toBe(false);
    expect(logEntries('002-b')).toEqual([expect.stringContaining('Merged origin/main into')]);
  });

  it('falls back to the local branch when the fetch fails, and says so', async () => {
    tasks.push(task('002-b', 'in_progress'));
    await merged('pr');
    const [notice] = await texts('002-b');
    expect(notice).toContain('run `git merge --no-edit main`');
    expect(notice).toContain('Workbench could not fetch `origin/main`, so this is your local `main`');
  });

  it('pulls into one worktree at a time', async () => {
    merges.delayMs = 50;
    const specIds = ['002-b', '003-c', '004-d'];
    tasks.push(...specIds.map((specId) => task(specId, 'human_review')));
    for (const specId of specIds) {
      mkdirSync(specDirOf(specId), { recursive: true });
      const wt = addWorktree(specId);
      commitFile(wt, `${specId}.txt`, 'work\n', 'work');
    }
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    await merged();

    expect(merges.max).toBe(1);
    for (const specId of specIds) expect(existsSync(path.join(worktreeOf(specId), 'c.txt'))).toBe(true);
  });

  it('tells a task that started before its pull to merge it itself', async () => {
    tasks.push(task('002-b', 'human_review'));
    mkdirSync(specDirOf('002-b'), { recursive: true });
    const wt = addWorktree('002-b');
    const head = git(wt, 'rev-parse', 'HEAD');
    commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    // Starts while Workbench checks its worktree, before the merge
    merges.onGit = (args) => {
      if (args[0] === 'merge-base') running.add('002-b');
    };
    await merged();

    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(await texts('002-b')).toEqual([expect.stringContaining('Merge it into your branch now')]);
  });
});
