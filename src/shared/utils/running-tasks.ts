/**
 * Which tasks use the (shared) model server and so count against the parallel task limit.
 * A task in AI review still runs a model process, so In Progress and AI Review both count;
 * moving a task from In Progress to AI Review never frees a slot.
 */
import type { Task, TaskStatus } from '../types';

export function isRunningStatus(status: TaskStatus): boolean {
  return status === 'in_progress' || status === 'ai_review';
}

/** Tasks that run now (archived ones excluded), not counting `excludeTaskId` */
export function countRunningTasks(tasks: readonly Pick<Task, 'id' | 'status' | 'metadata'>[], excludeTaskId?: string): number {
  return tasks.filter((t) => isRunningStatus(t.status) && !t.metadata?.archivedAt && t.id !== excludeTaskId).length;
}
