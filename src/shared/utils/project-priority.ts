/**
 * Cross-project rules for the task queue. All projects share one local model server, so:
 *
 * - the app setting `maxParallelTasks` is the TOTAL number of running tasks (in progress or in
 *   AI review) across all projects, and a project's own `maxParallelTasks` caps it further;
 * - a queued task may start whenever a global slot is free and its project's cap allows,
 *   unless a project with strictly higher priority has a startable queued task (that one gets
 *   the free slot first). Running work of a higher project never blocks by itself.
 *
 * Running tasks are never paused. Pure rules, used by the main process.
 */
import type { ProjectPriority, Task } from '../types';

/** What the queue rules need to know about a project */
export interface QueueProjectLike {
  id: string;
  name: string;
  settings?: { priority?: unknown };
}
import { isDependencySatisfied } from './autonomous';
import { reachedParallelCap } from './running-tasks';
import { isTaskOnRateLimitHold } from './rate-limit-hold';

export const PROJECT_PRIORITIES: readonly ProjectPriority[] = ['high', 'normal', 'low'];

const RANK: Record<ProjectPriority, number> = { low: 0, normal: 1, high: 2 };

/** The project's priority; unset or unknown = normal */
export function resolveProjectPriority(settings: { priority?: unknown } | undefined): ProjectPriority {
  const value = settings?.priority;
  return value === 'high' || value === 'low' ? value : 'normal';
}

/** Rank of a project's priority (higher = more important) */
export function projectPriorityRank(settings: { priority?: unknown } | undefined): number {
  return RANK[resolveProjectPriority(settings)];
}

/** Projects, highest priority first; equal priority keeps the given order */
export function sortByProjectPriority<P extends { settings?: { priority?: unknown } }>(projects: readonly P[]): P[] {
  return projects
    .map((p, index) => ({ p, index }))
    .sort((a, b) => projectPriorityRank(b.p.settings) - projectPriorityRank(a.p.settings) || a.index - b.index)
    .map((entry) => entry.p);
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

export interface PriorityRuleOptions {
  now?: number;
  /** Autonomous target of a task (see getAutonomousTargetSync); unset = dependencies need Done */
  getAutonomousTarget?: (projectId: string, task: Task) => string | undefined;
}

/** Whether a project has a queued task that could start: not archived, not on a rate-limit hold, dependencies satisfied */
export function hasStartableQueuedTask(
  projectId: string,
  tasks: readonly Task[],
  options: PriorityRuleOptions = {}
): boolean {
  const now = options.now ?? Date.now();
  return tasks.some(
    (t) =>
      t.status === 'queue' &&
      !t.metadata?.archivedAt &&
      !isTaskOnRateLimitHold(t, now) &&
      getUnmetDependencyIds(t, tasks, options.getAutonomousTarget?.(projectId, t)).length === 0
  );
}

/** Why a project's queued tasks do not start right now */
export type QueueHold =
  /** The total across all projects is used up */
  | { kind: 'slots'; used: number; max: number }
  /** A higher-priority project has startable queued tasks and gets the free slot first */
  | { kind: 'project'; projectId: string; name: string }
  /** The project's own cap is reached */
  | { kind: 'projectCap'; used: number; max: number };

/** Stable text for comparing holds */
export function queueHoldKey(hold: QueueHold | undefined | null): string {
  if (!hold) return '';
  return hold.kind === 'project' ? `project:${hold.projectId}` : `${hold.kind}:${hold.used}/${hold.max}`;
}

export interface QueueGateInput<P extends QueueProjectLike> {
  projects: readonly P[];
  tasksByProject: (projectId: string) => readonly Task[];
  /** Running tasks (in progress or AI review) of a project */
  runningCount: (projectId: string) => number;
  /** Total across all projects (app setting) */
  globalMax: number;
  /** A project's own cap; unset = none */
  projectMax: (projectId: string) => number | undefined;
}

/**
 * What keeps `project`'s queued tasks from starting automatically, if anything: the global cap,
 * the project's own cap, or a strictly higher-priority project with a startable queued task
 * (and room under its own cap). Equal priority never holds back.
 */
export function getQueueHold<P extends QueueProjectLike>(
  input: QueueGateInput<P>,
  project: Pick<QueueProjectLike, 'id' | 'settings'>,
  options: PriorityRuleOptions = {}
): QueueHold | undefined {
  const globalRunning = input.projects.reduce((sum, p) => sum + input.runningCount(p.id), 0);
  const projectRunning = input.runningCount(project.id);
  const projectMax = input.projectMax(project.id);
  const reached = reachedParallelCap({ globalRunning, projectRunning, globalMax: input.globalMax, projectMax });
  if (reached === 'global') return { kind: 'slots', used: globalRunning, max: input.globalMax };
  if (reached === 'project') return { kind: 'projectCap', used: projectRunning, max: projectMax as number };

  const mine = projectPriorityRank(project.settings);
  const higher = sortByProjectPriority(input.projects.filter((p) => p.id !== project.id && projectPriorityRank(p.settings) > mine));
  const blocker = higher.find((p) => {
    const cap = input.projectMax(p.id);
    if (cap !== undefined && input.runningCount(p.id) >= cap) return false;
    return hasStartableQueuedTask(p.id, input.tasksByProject(p.id), options);
  });
  return blocker ? { kind: 'project', projectId: blocker.id, name: blocker.name } : undefined;
}

/** Current holds and running counts of all projects, for a window that opens later */
export interface QueueHoldsSnapshot {
  holds: Array<{ projectId: string; hold: QueueHold }>;
  /** Running tasks per project (projects without any left out) */
  running: Record<string, number>;
}
