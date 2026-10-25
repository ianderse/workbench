/**
 * Which task branches Workbench is changing right now, so two of these never run on the same
 * branch at once, and no task run starts on a branch that is being merged:
 * - `localMerges`: the task's branch is being merged into its base branch locally
 * - `mergingPRs`: the task's pull request is being merged
 * - `branchSyncs`: another task was merged into this task's base branch and Workbench is merging
 *   that branch into the task's worktree (`task-resync/`)
 *
 * Keyed by project and task (`guardKey`): a task id is its spec id (`001-<slug>`), which every
 * project numbers from its own start, so a bare id would let one project's merge block (or miss)
 * another project's task of the same name.
 */

/** The key a task is held under in the sets below */
export const guardKey = (projectId: string, taskId: string): string => `${projectId}\u0000${taskId}`;

/** Tasks whose branch is being merged locally */
export const localMerges = new Set<string>();

/** Tasks whose pull request is being merged */
export const mergingPRs = new Set<string>();

/** Tasks whose worktree is taking in their base branch after another task was merged */
export const branchSyncs = new Set<string>();

/** The pull running for a task in `branchSyncs`, so a task run can wait for it to end */
const branchSyncDone = new Map<string, Promise<unknown>>();

/** Run a pull into a task's worktree, with the task marked in `branchSyncs` meanwhile */
export async function runBranchSync<T>(projectId: string, taskId: string, pull: () => Promise<T>): Promise<T> {
  const key = guardKey(projectId, taskId);
  branchSyncs.add(key);
  const done = pull();
  branchSyncDone.set(key, done.catch(() => undefined));
  try {
    return await done;
  } finally {
    branchSyncs.delete(key);
    branchSyncDone.delete(key);
  }
}

/** Wait until no pull is changing the task's worktree (a run starting must not race one) */
export async function waitForBranchSync(projectId: string, taskId: string): Promise<void> {
  await branchSyncDone.get(guardKey(projectId, taskId));
}

/** Whether the task's branch is being merged (locally or through its pull request) right now */
export function isTaskBranchMerging(projectId: string, taskId: string): boolean {
  const key = guardKey(projectId, taskId);
  return localMerges.has(key) || mergingPRs.has(key);
}

/** Whether Workbench is merging or updating the task's branch right now */
export function isTaskBranchBusy(projectId: string, taskId: string): boolean {
  return isTaskBranchMerging(projectId, taskId) || branchSyncs.has(guardKey(projectId, taskId));
}

/** Why a task can't start now because its branch is being merged, or undefined when it can */
export function branchMergeBlocker(projectId: string, taskId: string): string | undefined {
  const key = guardKey(projectId, taskId);
  if (localMerges.has(key)) return "This task's branch is being merged. Try again when the merge has finished.";
  if (mergingPRs.has(key)) return "This task's pull request is being merged. Try again when the merge has finished.";
  return undefined;
}
