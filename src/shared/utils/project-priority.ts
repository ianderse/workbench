/**
 * Cross-project priority for the task queue. All projects share one local model server, so a
 * lower-priority project starts queued tasks only while every higher-priority project has
 * nothing it could run. Running tasks are never paused. Pure rules, used by the main process.
 */
import type { Project, ProjectPriority, Task } from '../types';
import { isDependencySatisfied } from './autonomous';
import { isRunningStatus } from './running-tasks';
import { isTaskOnRateLimitHold } from './rate-limit-hold';

export const PROJECT_PRIORITIES: readonly ProjectPriority[] = ['high', 'normal', 'low'];

const RANK: Record<ProjectPriority, number> = { low: 0, normal: 1, high: 2 };

/** The project's priority; unset or unknown = normal */
export function resolveProjectPriority(settings: { priority?: unknown } | undefined): ProjectPriority {
  const value = settings?.priority;
  return value === 'high' || value === 'low' ? value : 'normal';
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

/** Whether a project has work it can run now: a task running or in AI review, or a queued task that could start */
export function projectHasRunnableWork(
  projectId: string,
  tasks: readonly Task[],
  options: PriorityRuleOptions = {}
): boolean {
  const now = options.now ?? Date.now();
  return tasks.some((t) => {
    if (t.metadata?.archivedAt) return false;
    if (isRunningStatus(t.status)) return true;
    if (t.status !== 'queue') return false;
    return (
      !isTaskOnRateLimitHold(t, now) &&
      getUnmetDependencyIds(t, tasks, options.getAutonomousTarget?.(projectId, t)).length === 0
    );
  });
}

/**
 * The project that holds `project`'s queued tasks back: the first project with a strictly higher
 * priority that has runnable work (highest priority first). Equal priority never blocks.
 */
export function blockingHigherPriorityProject<P extends Pick<Project, 'id' | 'name' | 'settings'>>(
  projects: readonly P[],
  tasksByProject: (projectId: string) => readonly Task[],
  project: Pick<Project, 'id' | 'settings'>,
  options: PriorityRuleOptions = {}
): P | undefined {
  const mine = RANK[resolveProjectPriority(project.settings)];
  const higher = projects
    .filter((p) => p.id !== project.id && RANK[resolveProjectPriority(p.settings)] > mine)
    .sort((a, b) => RANK[resolveProjectPriority(b.settings)] - RANK[resolveProjectPriority(a.settings)]);
  return higher.find((p) => projectHasRunnableWork(p.id, tasksByProject(p.id), options));
}
