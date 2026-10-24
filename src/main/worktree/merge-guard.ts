/**
 * Which task branches Workbench is changing right now (keyed by task id), so two of these never
 * run on the same branch at once:
 * - `localMerges`: the task's branch is being merged into its base branch locally
 * - `mergingPRs`: the task's pull request is being merged
 * - `branchSyncs`: another task was merged into this task's base branch and Workbench is merging
 *   that branch into the task's worktree (`task-messaging/merge-sync.ts`)
 */

/** Tasks whose branch is being merged locally */
export const localMerges = new Set<string>();

/** Tasks whose pull request is being merged */
export const mergingPRs = new Set<string>();

/** Tasks whose worktree is taking in their base branch after another task was merged */
export const branchSyncs = new Set<string>();

/** The pull running for a task in `branchSyncs`, so a task run can wait for it to end */
const branchSyncDone = new Map<string, Promise<unknown>>();

/** Run a pull into a task's worktree, with the task marked in `branchSyncs` meanwhile */
export async function runBranchSync<T>(taskId: string, pull: () => Promise<T>): Promise<T> {
  branchSyncs.add(taskId);
  const done = pull();
  branchSyncDone.set(taskId, done.catch(() => undefined));
  try {
    return await done;
  } finally {
    branchSyncs.delete(taskId);
    branchSyncDone.delete(taskId);
  }
}

/** Wait until no pull is changing the task's worktree (a run starting must not race one) */
export async function waitForBranchSync(taskId: string): Promise<void> {
  await branchSyncDone.get(taskId);
}

/** Whether Workbench is merging or updating the task's branch right now */
export function isTaskBranchBusy(taskId: string): boolean {
  return localMerges.has(taskId) || mergingPRs.has(taskId) || branchSyncs.has(taskId);
}
