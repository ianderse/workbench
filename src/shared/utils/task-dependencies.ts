/**
 * What a ticket relies on, by ticket number. Reads `metadata.dependsOnTaskIds` (ids or spec ids)
 * and uses the same satisfied rules as the task queue.
 */
import type { Task } from '../types';
import { ANY_TARGET_BRANCH, isDependencySatisfied } from './autonomous';
import { taskNumber } from './queue-grooming';

/** done/merged: finished (merged automatically counts); archived: set aside; missing: no such task */
export type TaskDependencyState = 'done' | 'merged' | 'archived' | 'waiting' | 'missing';

export interface TaskDependency {
  /** The id as written in `dependsOnTaskIds` */
  ref: string;
  /** "003" */
  number: string;
  /** Empty when the task is missing */
  title: string;
  state: TaskDependencyState;
}

/** Every dependency of a task, in the order they are listed */
export function resolveTaskDependencies(tasks: readonly Task[], task: Task, autonomous = false): TaskDependency[] {
  const refs = task.metadata?.dependsOnTaskIds ?? [];
  const result: TaskDependency[] = [];
  for (const ref of refs) {
    if (ref === task.id) continue;
    const dep = tasks.find((x) => x.id === ref || x.specId === ref);
    if (!dep) {
      result.push({ ref, number: taskNumber(ref), title: '', state: 'missing' });
      continue;
    }
    let state: TaskDependencyState;
    if (dep.metadata?.archivedAt) state = 'archived';
    else if (dep.status === 'done') state = 'done';
    else if (isDependencySatisfied(dep, autonomous ? ANY_TARGET_BRANCH : undefined)) state = 'merged';
    else state = 'waiting';
    result.push({ ref, number: taskNumber(dep.id), title: dep.title, state });
  }
  return result;
}

/** "#003 Title, #005 Title" for the dependencies a task still waits for; '' when none. A string, so selectors stay stable. */
export function unmetDependencyLabel(tasks: readonly Task[], task: Task, autonomous = false): string {
  return resolveTaskDependencies(tasks, task, autonomous)
    .filter((dep) => dep.state === 'waiting')
    .map((dep) => `#${dep.number} ${dep.title}`)
    .join(', ');
}
