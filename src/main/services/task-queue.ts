/**
 * Task Queue
 * ==========
 *
 * Main-process queue promotion: whenever a task enters or leaves the Queue or In Progress
 * column, the running count (In Progress + AI Review) of ALL projects is checked against the
 * app-wide parallel task limit (all projects share one model server) and the project's own
 * cap, if set; while there is a free slot, the top eligible task of the Queue column (as the
 * board orders it) is started, and the check repeats until the Queue is empty or a cap is
 * reached. A project with strictly higher priority that has a startable queued task gets
 * free slots first (see shared/utils/project-priority.ts); passes of several projects run
 * one after the other, highest priority first.
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
import type { Project } from '../../shared/types';
import { isRunningStatus } from '../../shared/utils/running-tasks';
import {
  getQueueHold,
  getUnmetDependencyIds,
  queueHoldKey,
  sortByProjectPriority,
  type QueueHold,
} from '../../shared/utils/project-priority';
import { countRunningTasks } from '../../shared/utils/running-tasks';

export { getUnmetDependencyIds };

/** Delay used to coalesce bursts of requests (e.g. "Queue all") into one pass. */
const TASK_QUEUE_DEBOUNCE_MS = 100;

/** A pass stops after this many failed starts (likely a shared cause, e.g. auth or git). */
export const MAX_FAILED_STARTS_PER_PASS = 3;

export interface TaskQueueDeps {
  /** All project ids (used when a request names no project). */
  listProjectIds: () => string[];
  /** Current tasks of a project (fresh after status writes). */
  listTasks: (projectId: string) => Task[];
  /** Total number of running tasks allowed across ALL projects. */
  getMaxParallelTasks: () => number;
  /** A project's own cap on its running tasks; unset = only the total applies. */
  getProjectMaxParallelTasks?: (projectId: string) => number | undefined;
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
  /** All projects (name and settings, for the cross-project priority); unset = equal priority */
  listProjects?: () => Array<{ id: string; name: string; settings?: Project['settings'] }>;
  /** What holds this project's queued tasks back changed (undefined = not held) */
  onHoldChange?: (projectId: string, hold: QueueHold | undefined) => void;
  /** Running tasks per project (only projects with any) changed */
  onUsageChange?: (running: Record<string, number>) => void;
  /** Debounce override for tests. */
  debounceMs?: number;
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

  private getProjects(deps: TaskQueueDeps): Array<{ id: string; name: string; settings?: Project['settings'] }> {
    return deps.listProjects?.() ?? deps.listProjectIds().map((id) => ({ id, name: id, settings: undefined }));
  }

  /**
   * What currently keeps this project's queued tasks from starting automatically, if anything
   * (free slots, the project's own cap, a higher-priority project that goes first). Manual
   * starts ignore the priority part. `extraRunning` = tasks started in the running pass whose
   * status is not written yet (not counted twice).
   */
  getHold(projectId: string, extraRunning: ReadonlySet<string> = new Set()): QueueHold | undefined {
    const deps = this.deps;
    if (!deps) return undefined;
    try {
      const projects = this.getProjects(deps);
      const project = projects.find((p) => p.id === projectId);
      if (!project) return undefined;
      const cache = new Map<string, Task[]>();
      const tasksOf = (id: string): Task[] => {
        let tasks = cache.get(id);
        if (!tasks) {
          tasks = deps.listTasks(id);
          cache.set(id, tasks);
        }
        return tasks;
      };
      const runningCount = (id: string): number => {
        const tasks = tasksOf(id);
        if (id !== projectId || extraRunning.size === 0) return countRunningTasks(tasks);
        const ids = new Set(tasks.filter((t) => isRunningStatus(t.status) && !t.metadata?.archivedAt).map((t) => t.id));
        for (const taskId of extraRunning) ids.add(taskId);
        return ids.size;
      };
      return getQueueHold(
        {
          projects,
          tasksByProject: tasksOf,
          runningCount,
          globalMax: deps.getMaxParallelTasks(),
          projectMax: (id) => deps.getProjectMaxParallelTasks?.(id),
        },
        project,
        { getAutonomousTarget: deps.getAutonomousTarget }
      );
    } catch (error) {
      console.warn(`[TaskQueue] Failed to check the queue limits of project ${projectId}:`, error);
      return undefined;
    }
  }

  /** Holds last reported per project (project id -> hold) */
  private holds = new Map<string, QueueHold>();
  private lastUsageKey = '';
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Current holds, for windows that open later */
  getHolds(): Array<{ projectId: string; hold: QueueHold }> {
    const result: Array<{ projectId: string; hold: QueueHold }> = [];
    for (const projectId of this.holds.keys()) {
      const hold = this.getHold(projectId);
      if (hold) result.push({ projectId, hold });
    }
    return result;
  }

  /** Running tasks per project (projects without any left out), for windows that open later */
  getRunningByProject(): Record<string, number> {
    const deps = this.deps;
    const result: Record<string, number> = {};
    if (!deps) return result;
    try {
      for (const id of deps.listProjectIds()) {
        const count = countRunningTasks(deps.listTasks(id));
        if (count > 0) result[id] = count;
      }
    } catch (error) {
      console.warn('[TaskQueue] Failed to count running tasks:', error);
    }
    return result;
  }

  private reportUsage(): void {
    if (!this.deps?.onUsageChange) return;
    const running = this.getRunningByProject();
    const key = JSON.stringify(running);
    if (key === this.lastUsageKey) return;
    this.lastUsageKey = key;
    try {
      this.deps.onUsageChange(running);
    } catch (error) {
      console.warn('[TaskQueue] Failed to report running tasks:', error);
    }
  }

  private reportHold(projectId: string, hold: QueueHold | undefined): void {
    if (queueHoldKey(this.holds.get(projectId)) === queueHoldKey(hold)) return;
    if (hold) this.holds.set(projectId, hold);
    else this.holds.delete(projectId);
    try {
      this.deps?.onHoldChange?.(projectId, hold);
    } catch (error) {
      console.warn('[TaskQueue] Failed to report a queue hold:', error);
    }
  }

  /**
   * A task stopped running somewhere (a slot may be free): run the queues of all projects,
   * highest priority first, after a short delay (bursts of state changes coalesce).
   */
  requestAllProjects(wakeDelayMs = 2000): void {
    if (!this.deps || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.request();
    }, wakeDelayMs);
  }

  /** Cancel a pending debounced pass. */
  dispose(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
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
    // One project after the other, highest priority first: all projects draw on the same
    // slots, so parallel passes could start more tasks than the total allows
    try {
      const priority = new Map(sortByProjectPriority(this.getProjects(deps)).map((p, index) => [p.id, index]));
      projectIds.sort((a, b) => (priority.get(a) ?? Infinity) - (priority.get(b) ?? Infinity));
    } catch (error) {
      console.warn('[TaskQueue] Failed to order projects by priority:', error);
    }
    for (const id of projectIds) await this.processProject(id);
    this.reportUsage();
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
      try {
        tasks = deps.listTasks(projectId);
      } catch (error) {
        console.warn(`[TaskQueue] Failed to read tasks of project ${projectId}:`, error);
        return;
      }

      const queueOrder = deps.getQueueOrder?.(projectId) ?? [];
      const next = getPromotableQueuedTasks(tasks, Date.now(), queueOrder, (t) => deps.getAutonomousTarget?.(projectId, t)).find(
        (t) => !started.has(t.id) && !failed.has(t.id) && !deps.isTaskRunning?.(t.id, projectId)
      );
      if (!next) {
        // Nothing waiting to start, so nothing is held
        this.reportHold(projectId, undefined);
        return;
      }

      // Free slots (total, and the project's own cap) and higher-priority projects going first.
      // In Progress and AI Review both run a model process, so both fill a slot.
      const hold = this.getHold(projectId, started);
      this.reportHold(projectId, hold);
      if (hold) return;

      console.warn(`[TaskQueue] Starting queued task ${next.id} of project ${projectId}`);
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
