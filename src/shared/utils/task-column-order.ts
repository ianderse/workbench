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
