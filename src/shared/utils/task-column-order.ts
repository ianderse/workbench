/**
 * Kanban column order
 *
 * The order tasks appear in a column: tasks without a saved position come first (newest first),
 * then the tasks the user arranged, in their saved order. The board renders columns with this,
 * and the main-process queue uses it to start the top task of the Queue column first.
 */
import type { Task } from '../types';

const newestFirst = (a: Pick<Task, 'createdAt'>, b: Pick<Task, 'createdAt'>): number =>
  new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

/** Sort one column's tasks as the board shows them, given the column's saved order (task ids) */
export function sortColumnTasks<T extends Pick<Task, 'id' | 'createdAt'>>(tasks: T[], savedOrder?: readonly string[] | null): T[] {
  if (!savedOrder || savedOrder.length === 0) return [...tasks].sort(newestFirst);

  const position = new Map<string, number>();
  savedOrder.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  const unplaced = tasks.filter((t) => !position.has(t.id)).sort(newestFirst);
  const placed = tasks
    .filter((t) => position.has(t.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return [...unplaced, ...placed];
}

/**
 * When a task arrived in Human Review: its automatic merge, else the end of its run's last step,
 * else its last update. Creation time says nothing about how long it has waited for review.
 */
export function reviewArrivedAt(task: Pick<Task, 'createdAt' | 'updatedAt' | 'metadata' | 'claudeRun'>): number {
  const stamp = task.metadata?.autoMerge?.at ?? task.claudeRun?.phases.at(-1)?.endedAt ?? task.updatedAt ?? task.createdAt;
  const time = new Date(stamp as string | Date).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Human Review is a review queue: the task that has waited longest is on top, and new arrivals
 * join the bottom (oldest first, by arrival in review; a manual order doesn't apply here)
 */
export function sortReviewColumn<T extends Pick<Task, 'id' | 'createdAt' | 'updatedAt' | 'metadata' | 'claudeRun'>>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => reviewArrivedAt(a) - reviewArrivedAt(b) || a.id.localeCompare(b.id));
}
