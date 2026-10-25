/**
 * Stopped by the user
 * ===================
 *
 * `<specDir>/stopped_by_user.json`, written when the user stops a task (Stop, or moving its card
 * out of In Progress) before the task's state changes, and removed by the task's next start. While
 * it is there nothing starts the task on its own (the resync service, its scan at startup) and the
 * task's arrival in Human Review is not announced as finished work.
 *
 * A file rather than the run's last phase: the run writes its "Stopped" phase only after the state
 * change, and a stop during preparation or triage writes none.
 */
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { writeFileAtomicSync } from '../utils/atomic-file';

export const USER_STOP_FILE = 'stopped_by_user.json';

/** Record that the user stopped the task */
export function markStoppedByUser(specDir: string, now = new Date()): void {
  try {
    mkdirSync(specDir, { recursive: true });
    writeFileAtomicSync(path.join(specDir, USER_STOP_FILE), JSON.stringify({ at: now.toISOString() }));
  } catch {
    // The spec dir is gone (the task was deleted)
  }
}

/** The task starts again: forget the stop */
export function clearStoppedByUser(specDir: string): void {
  try {
    rmSync(path.join(specDir, USER_STOP_FILE), { force: true });
  } catch {
    // Already gone
  }
}

/** Whether the user stopped the task and has not started it since */
export function isStoppedByUser(specDir: string): boolean {
  return existsSync(path.join(specDir, USER_STOP_FILE));
}
