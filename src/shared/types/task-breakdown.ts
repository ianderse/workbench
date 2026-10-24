/** "Break into tasks": a big prompt turned into several dependent task cards */

export interface BreakdownTask {
  /** Short id inside the breakdown, e.g. "t1" */
  key: string;
  title: string;
  /** Self-contained: each card runs in its own session */
  description: string;
  /** Keys of the tasks that must be merged first */
  dependsOn: string[];
}

export interface TaskBreakdown {
  tasks: BreakdownTask[];
}
