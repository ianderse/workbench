/**
 * Task Queue
 * ==========
 *
 * Main-process queue promotion: whenever a task enters or leaves the Queue or In Progress
 * column, the project's In Progress count is checked against the parallel task limit; while
 * there is a free slot, the top eligible task of the Queue column (as the board orders it) is
 * started, and the check repeats until the Queue is empty or the limit is reached.
 *
 * It runs in the main process (the source of truth for task status) so promotion
 * works regardless of renderer state: whichever view is open, for every project,
 * after app start, and after the limit is raised. Callers just `request()` a pass
 * whenever something may have freed a slot or queued a task (any status change, a
 * task list load, a settings change). Requests are coalesced, and passes for a
 * project run one at a time (`runExclusive`), so two triggers can't start the
 * same task twice or start more tasks than the limit allows.
 *
 * A queued task with `metadata.dependsOnTaskIds` waits until every one of those tasks is done
 * (merged): each task branches from the project's base branch, so a dependent task can only
 * see its predecessor's code after the merge. A task whose PR is open (`pr_created`) is not
 * merged yet and still blocks; a deleted or archived dependency counts as satisfied.
 *
 * Tasks on a rate-limit hold are skipped: the rate-limit resume scheduler restarts
 * them at their reset time.
 */
import type { Task } from '../../shared/types';
import { isTaskOnRateLimitHold } from '../../shared/utils/rate-limit-hold';
import { sortColumnTasks } from '../../shared/utils/task-column-order';
import { isDependencySatisfied } from '../../shared/utils/autonomous';

/** Delay used to coalesce bursts of requests (e.g. "Queue all") into one pass. */
const TASK_QUEUE_DEBOUNCE_MS = 100;

/** A pass stops after this many failed starts (likely a shared cause, e.g. auth or git). */
export const MAX_FAILED_STARTS_PER_PASS = 3;

export interface TaskQueueDeps {
  /** All project ids (used when a request names no project). */
  listProjectIds: () => string[];
  /** Current tasks of a project (fresh after status writes). */
  listTasks: (projectId: string) => Task[];
  /** Parallel task limit for a project. */
  getMaxParallelTasks: (projectId: string) => number;
  /** Saved order of the project's Queue column (task ids, as the board keeps it). */
  getQueueOrder?: (projectId: string) => string[];
  /** Whether a task already has an active run. */
  /**
   * Whether a task already has a run. The project is given because a task id is only unique within
   * one: without it, a task id that two projects are running resolves to neither, reads as not
   * running, and a promotion pass starts a second run of its own project's task over the first.
   */
  isTaskRunning?: (taskId: string, projectId: string) => boolean;
  /**
   * Start a queued task (moves it to In Progress). Resolves to whether it started;
   * a false result or a thrown error counts as a failed start.
   */
  startTask: (taskId: string, projectId: string) => Promise<boolean>;
  /**
   * Autonomous mode: the branch a task will branch from and be merged into, or undefined while the
   * project's autonomous mode is off. A dependency auto-merged into it no longer blocks the task.
   */
  getAutonomousTarget?: (projectId: string, task: Task) => string | undefined;
  /** Debounce override for tests. */
  debounceMs?: number;
}

/**
 * Ids of the tasks this task still waits for: dependencies that exist, aren't archived and
 * aren't done yet. A dependency that no longer exists (deleted) counts as satisfied.
 */
export function getUnmetDependencyIds(task: Task, tasks: readonly Task[], autonomousTarget?: string): string[] {
  const ids = task.metadata?.dependsOnTaskIds;
  if (!ids || ids.length === 0) return [];
  return ids.filter((depId) => {
    if (depId === task.id) return false;
    const dep = tasks.find((t) => t.id === depId || t.specId === depId);
    return !!dep && !isDependencySatisfied(dep, autonomousTarget) && !dep.metadata?.archivedAt;
  });
}

/**
 * Queued tasks that may be promoted now, top of the Queue column first (the board's order:
 * unplaced tasks newest first, then the saved order): not archived and not waiting for a
 * rate limit to reset and not waiting for a task it depends on.
 */
export function getPromotableQueuedTasks(
  tasks: Task[],
  now: number = Date.now(),
  queueOrder?: readonly string[],
  getAutonomousTarget?: (task: Task) => string | undefined
): Task[] {
  const queued = tasks.filter((t) => t.status === 'queue' && !t.metadata?.archivedAt);
  return sortColumnTasks(queued, queueOrder).filter(
    (t) => !isTaskOnRateLimitHold(t, now) && getUnmetDependencyIds(t, tasks, getAutonomousTarget?.(t)).length === 0
  );
}

export class TaskQueue {
  private deps: TaskQueueDeps | null = null;
  /** Tail of each project's chain of exclusive operations */
  private chains = new Map<string, Promise<void>>();
  /** Projects waiting for the debounced pass; null = all projects */
  private pending = new Set<string | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  configure(deps: TaskQueueDeps): void {
    this.deps = deps;
  }

  /**
   * Ask for a promotion pass for a project (or all projects when omitted).
   * Requests within the debounce window are coalesced into one pass per project.
   */
  request(projectId?: string): void {
    if (!this.deps) return;
    this.pending.add(projectId ?? null);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.deps.debounceMs ?? TASK_QUEUE_DEBOUNCE_MS);
  }

  /**
   * Run `fn` after every earlier exclusive operation for the project has finished.
   * Other code that starts queued tasks (e.g. the rate-limit resume) uses this so it
   * can't race a promotion pass.
   */
  runExclusive<T>(projectId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(projectId, tail);
    void tail.then(() => {
      if (this.chains.get(projectId) === tail) this.chains.delete(projectId);
    });
    return run;
  }

  /** Promote queued tasks of a project until the limit is reached (serialized per project). */
  processProject(projectId: string): Promise<void> {
    return this.runExclusive(projectId, () => this.promote(projectId));
  }

  /** Cancel a pending debounced pass. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private async flush(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    const requested = Array.from(this.pending);
    this.pending.clear();

    let projectIds: string[];
    if (requested.includes(null)) {
      try {
        projectIds = deps.listProjectIds();
      } catch (error) {
        console.warn('[TaskQueue] Failed to list projects:', error);
        return;
      }
    } else {
      projectIds = requested as string[];
    }
    await Promise.all(projectIds.map((id) => this.processProject(id)));
  }

  private async promote(projectId: string): Promise<void> {
    const deps = this.deps;
    if (!deps) return;

    // Tasks started in this pass count as running even before their status is written,
    // and are never picked twice
    const started = new Set<string>();
    const failed = new Set<string>();

    while (failed.size < MAX_FAILED_STARTS_PER_PASS) {
      let tasks: Task[];
      let maxParallel: number;
      try {
        tasks = deps.listTasks(projectId);
        maxParallel = deps.getMaxParallelTasks(projectId);
      } catch (error) {
        console.warn(`[TaskQueue] Failed to read tasks of project ${projectId}:`, error);
        return;
      }

      const inProgressIds = new Set(
        tasks.filter((t) => t.status === 'in_progress' && !t.metadata?.archivedAt).map((t) => t.id)
      );
      for (const id of started) inProgressIds.add(id);
      if (inProgressIds.size >= maxParallel) return;

      const queueOrder = deps.getQueueOrder?.(projectId) ?? [];
      const next = getPromotableQueuedTasks(tasks, Date.now(), queueOrder, (t) => deps.getAutonomousTarget?.(projectId, t)).find(
        (t) => !started.has(t.id) && !failed.has(t.id) && !deps.isTaskRunning?.(t.id, projectId)
      );
      if (!next) return;

      console.warn(`[TaskQueue] Starting queued task ${next.id} (${inProgressIds.size + 1}/${maxParallel} in progress)`);
      let ok = false;
      try {
        ok = await deps.startTask(next.id, projectId);
      } catch (error) {
        console.warn(`[TaskQueue] Failed to start queued task ${next.id}:`, error);
      }
      if (ok) {
        started.add(next.id);
      } else {
        failed.add(next.id);
      }
    }
    console.warn(`[TaskQueue] Stopped promoting tasks of project ${projectId} after ${failed.size} failed starts`);
  }
}

/** App-wide queue (configured in registerTaskExecutionHandlers). */
export const taskQueue = new TaskQueue();
