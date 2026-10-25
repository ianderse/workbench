/**
 * Task hooks: listeners that run on every task state and on the files a task's Claude Code
 * session edits, wherever they happen (state machine, manual moves, task runs).
 *
 * Kept free of Electron and the app logger so any main-process module can emit hooks.
 */
import type { Project, Task, TaskStatus } from '../shared/types';

export interface TaskHookEvents {
  /** The task entered a state: its board status and, when the state machine moved it, the machine state */
  state: { project: Project; task: Task; status: TaskStatus; state?: string };
  /** The task's Claude Code session edited files (paths relative to its worktree, forward slashes) */
  'files-edited': { project: Project; task: Task; files: string[] };
  /** The task's branch was merged into its base branch (local merge, merged pull request or full worktree merge) and the task is done */
  merged: { project: Project; task: Task };
  /** Autonomous mode merged the task into `into` (its target branch); the task stays in Human Review */
  'auto-merged': { project: Project; task: Task; into: string };
}

type TaskHookName = keyof TaskHookEvents;
type TaskHookHandler<K extends TaskHookName> = (event: TaskHookEvents[K]) => void | Promise<void>;

const handlers: { [K in TaskHookName]: Set<TaskHookHandler<K>> } = {
  state: new Set(),
  'files-edited': new Set(),
  merged: new Set(),
  'auto-merged': new Set(),
};

function reportFailure(name: TaskHookName, error: unknown): void {
  console.warn(`[TaskHooks] A ${name} hook failed:`, error);
}

export const taskHooks = {
  /** Register a hook; returns a function that removes it */
  on<K extends TaskHookName>(name: K, handler: TaskHookHandler<K>): () => void {
    handlers[name].add(handler);
    return () => {
      handlers[name].delete(handler);
    };
  },

  /** Run the hooks registered for `name`; a failing hook never affects the caller or other hooks */
  emit<K extends TaskHookName>(name: K, event: TaskHookEvents[K]): void {
    for (const handler of handlers[name]) {
      try {
        const result = handler(event);
        if (result instanceof Promise) result.catch((error) => reportFailure(name, error));
      } catch (error) {
        reportFailure(name, error);
      }
    }
  },
};
