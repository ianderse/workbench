/**
 * Task resync
 * ===========
 *
 * When a task is merged into a branch, the other tasks based on that branch that ran on the old
 * version of it go back to In Progress on their own: their session merges the branch in, resolves
 * conflicts keeping both sides' intent, and carries on where it stopped (then validates as usual).
 *
 * - Merge sync (`task-messaging/merge-sync.ts`) records a resync request in the task
 *   (`request.ts`) and asks this service to act on it when the task is not running.
 * - A task that was running when the merge happened is checked again when its run ends (the
 *   `state` task hook), so a notice it never acted on is not lost.
 * - Here, per task: nothing to do when its branch already has the merge; a note when its worktree
 *   has uncommitted changes or a merge in progress (the request waits for its next start); a plain
 *   fast-forward when it has no commits of its own; otherwise it starts now, or waits in the Queue
 *   when the project runs as many tasks as it may (the queue's start applies the request).
 * - The run itself applies the request (`ClaudeTaskRun` with `resync`); any start does: the user's,
 *   the queue's, a rate-limit resume. A failed resync is not retried automatically.
 *
 * Checks for a project run one at a time, together with the queue's passes (`runExclusive`).
 */
import path from 'path';
import { readFile } from 'fs/promises';
import type { Project, Task, TaskStatus } from '../../shared/types';
import { getSpecsDir } from '../../shared/constants/config';
import { appLog } from '../app-logger';
import { TaskLogWriter } from '../claude-code/task-log';
import { taskHooks } from '../task-hooks';
import { findTaskWorktree } from '../worktree-paths';
import { isTaskBranchBusy, runBranchSync } from '../worktree/merge-guard';
import { pullIntoWorktree } from '../task-messaging/merge-sync';
import { inspectResync } from './git';
import { clearResyncRequest, readResyncRequest, updateResyncRequest, type ResyncRequest } from './request';

/** Statuses of a task that has stopped and may be brought back to In Progress */
export const RESYNC_IDLE_STATUSES = new Set<TaskStatus>(['human_review', 'error', 'pr_created']);
/** How long after a run ends its pending request is looked at (the run winds down first) */
const AFTER_RUN_DELAY_MS = 1500;
/** How often a task whose run is still winding down is looked at again */
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 30;

export interface TaskResyncDeps {
  getProject: (projectId: string) => Project | undefined;
  getTasks: (projectId: string) => Task[];
  /** Whether the task has a run */
  isRunning: (taskId: string, projectId: string) => boolean;
  /** Whether the project runs as many tasks in parallel as it may (not counting `taskId`) */
  isAtParallelLimit: (project: Project, taskId: string) => boolean;
  /** Start the task now (In Progress); its run applies the request */
  start: (taskId: string, projectId: string) => Promise<void>;
  /** Move the task to the Queue; the queue starts it when a slot is free */
  queue: (project: Project, task: Task) => Promise<void>;
  /** Tell the task something for its next run (its inbox) */
  note?: (project: Project, task: Task, text: string) => Promise<void>;
  /** Run `fn` after the project's other queue work (TaskQueue.runExclusive) */
  runExclusive: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /** Delays override (tests) */
  delays?: { afterRunMs?: number; retryMs?: number };
}

/** What happened to a task's request, for tests and logs */
export type ResyncAction = 'none' | 'up-to-date' | 'noted' | 'fast-forwarded' | 'started' | 'queued' | 'retry';

function specDirOf(project: Project, task: Pick<Task, 'specId'>): string {
  return path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
}

function describeMerged(request: ResyncRequest): string {
  const names = request.merged.map((t) => `task ${t.specId}${t.title ? ` "${t.title.replace(/"/g, "'")}"` : ''}`);
  return names.length ? names.join(', ') : 'another task';
}

export class TaskResync {
  private deps: TaskResyncDeps | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private offState: (() => void) | null = null;

  /** Set the app's hooks and listen for runs that end (once, at app start) */
  configure(deps: TaskResyncDeps): void {
    this.deps = deps;
    this.offState?.();
    this.offState = taskHooks.on('state', ({ project, task, status }) => {
      if (RESYNC_IDLE_STATUSES.has(status)) void this.afterRun(project, task);
    });
  }

  /** Stop listening and cancel scheduled checks */
  dispose(): void {
    this.offState?.();
    this.offState = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deps = null;
  }

  /** A task that is not running got a resync request: act on it */
  request(projectId: string, taskId: string): void {
    this.schedule(projectId, taskId, 0, 0);
  }

  /** Requests left over from before a restart (tasks waiting in Human Review or Error) */
  scan(projectIds: string[]): void {
    const deps = this.deps;
    if (!deps) return;
    for (const projectId of projectIds) {
      const project = deps.getProject(projectId);
      if (!project) continue;
      for (const task of deps.getTasks(projectId)) {
        if (!RESYNC_IDLE_STATUSES.has(task.status) || task.metadata?.archivedAt) continue;
        const request = readResyncRequest(specDirOf(project, task));
        if (request && !request.failedAt) this.schedule(projectId, task.id, 0, 0);
      }
    }
  }

  /** A task stopped (its run ended): a request it got while running is applied now */
  private async afterRun(project: Project, task: Task): Promise<void> {
    const request = readResyncRequest(specDirOf(project, task));
    if (!request || request.failedAt) return;
    // The user stopped it: leave it alone until the next merge or start
    if (await this.stoppedByUser(project, task)) return;
    this.schedule(project.id, task.id, this.deps?.delays?.afterRunMs ?? AFTER_RUN_DELAY_MS, 0);
  }

  private async stoppedByUser(project: Project, task: Task): Promise<boolean> {
    try {
      const info = JSON.parse(await readFile(path.join(specDirOf(project, task), 'claude_run.json'), 'utf-8')) as {
        phases?: Array<{ isError?: boolean; error?: string }>;
      };
      const last = info.phases?.at(-1);
      return last?.isError === true && last.error === 'Stopped';
    } catch {
      return false;
    }
  }

  private schedule(projectId: string, taskId: string, delayMs: number, attempt: number): void {
    const key = `${projectId}\u0000${taskId}`;
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.process(projectId, taskId).then((action) => {
        if (action === 'retry' && attempt < MAX_RETRIES) {
          this.schedule(projectId, taskId, this.deps?.delays?.retryMs ?? RETRY_DELAY_MS, attempt + 1);
        }
      }).catch((error) => appLog.warn(`[TaskResync] Could not resync ${taskId}:`, error));
    }, delayMs));
  }

  /** Act on a task's pending request now (serialized with the project's queue passes) */
  process(projectId: string, taskId: string): Promise<ResyncAction> {
    const deps = this.deps;
    if (!deps) return Promise.resolve('none');
    return deps.runExclusive(projectId, () => this.apply(deps, projectId, taskId));
  }

  private async apply(deps: TaskResyncDeps, projectId: string, taskId: string): Promise<ResyncAction> {
    const project = deps.getProject(projectId);
    const task = deps.getTasks(projectId).find((t) => t.id === taskId);
    if (!project || !task || task.metadata?.archivedAt) return 'none';
    const specDir = specDirOf(project, task);
    const request = readResyncRequest(specDir);
    if (!request || request.failedAt) return 'none';
    // Still winding down (or started meanwhile, and so applies the request itself)
    if (deps.isRunning(task.id, projectId)) return RESYNC_IDLE_STATUSES.has(task.status) ? 'retry' : 'none';
    if (!RESYNC_IDLE_STATUSES.has(task.status)) return 'none';
    // A pull request is only brought up to date with a merge that was pushed
    if (request.via === 'local' && (task.status === 'pr_created' || (task.metadata?.prUrl && task.metadata.prState !== 'closed'))) return 'none';
    if (isTaskBranchBusy(projectId, task.id)) return 'retry';
    const worktreePath = task.metadata?.useWorktree === false ? null : findTaskWorktree(project.path, task.specId);
    if (!worktreePath) {
      clearResyncRequest(specDir, request.at);
      return 'none';
    }

    const need = await inspectResync(worktreePath, request.ref, project.autoBuildPath);
    switch (need) {
      case 'missing':
      case 'up-to-date':
        clearResyncRequest(specDir, request.at);
        return 'up-to-date';
      case 'dirty':
      case 'merging': {
        if (!request.notedAt) {
          const why = need === 'dirty' ? 'Your worktree has uncommitted changes' : 'A merge is in progress in your worktree';
          const text = `${describeMerged(request)} was merged into \`${request.into}\`, your base branch. ${why}, so Workbench did not start a sync: when you run again, you merge \`${request.ref}\` first.`;
          this.taskLog(specDir, task.specId, `${request.into} changed (${describeMerged(request)} merged). ${why}, so the sync waits for the next run`);
          await deps.note?.(project, task, text).catch(() => undefined);
          updateResyncRequest(specDir, request.at, { notedAt: new Date().toISOString() });
        }
        return 'noted';
      }
      case 'no-own-commits': {
        // Nothing of its own to merge with: take the base branch as it is
        const result = await runBranchSync(projectId, task.id, () =>
          pullIntoWorktree({ worktreePath, ref: request.ref, dataDir: project.autoBuildPath, canMerge: () => !deps.isRunning(task.id, projectId) }));
        if (result.status === 'merged' || result.status === 'up-to-date') {
          this.taskLog(specDir, task.specId, `Brought this task's branch up to date with ${request.ref} after ${describeMerged(request)} was merged`);
          clearResyncRequest(specDir, request.at);
          return 'fast-forwarded';
        }
        appLog.warn(`[TaskResync] Could not fast-forward ${task.specId} to ${request.ref}: ${result.status}`);
        return 'none';
      }
      default:
        break;
    }

    this.taskLog(specDir, task.specId, `${request.into} changed (${describeMerged(request)} merged): back to In Progress to merge ${request.ref} and carry on`);
    if (deps.isAtParallelLimit(project, task.id)) {
      await deps.queue(project, task);
      return 'queued';
    }
    await deps.start(task.id, projectId);
    return 'started';
  }

  private taskLog(specDir: string, specId: string, content: string): void {
    try {
      const log = new TaskLogWriter(specDir, specId);
      log.add('coding', 'info', content);
      log.saveNow();
    } catch (error) {
      appLog.warn(`[TaskResync] Could not write the task log of ${specId}:`, error);
    }
  }
}

/** App-wide resync service (configured in registerTaskExecutionHandlers) */
export const taskResync = new TaskResync();
