/**
 * Resolving the branch a task's worktree starts from.
 *
 * A task keeps the base branch it was created with. That branch can be deleted or renamed
 * afterwards, and `git worktree add <base>` then fails with "invalid reference", so a task
 * that was stopped a while ago can never be started again. Falling back to a branch that
 * still exists keeps it runnable, and the caller says which branch it actually used.
 */

import { git } from './git-exec';

/** Whether a branch resolves in the repo, as a local branch or on origin */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      await git(['rev-parse', '--verify', '--quiet', ref], { cwd, isolated: true });
      return true;
    } catch {
      // Not this one; try the next ref
    }
  }
  return false;
}

export interface BaseBranchResolution {
  /** The branch to start the worktree from */
  branch: string;
  /** The branch that was asked for, when it is gone and `branch` stands in for it */
  missing?: string;
}

/**
 * The first branch that still exists: the one asked for, else the first usable fallback.
 * When none of them exists the wanted branch is returned unchanged, so the caller (or git)
 * reports it as missing rather than silently branching from somewhere unrelated.
 */
export async function resolveBaseBranch(
  cwd: string,
  wanted: string,
  fallbacks: Array<string | undefined | null>,
): Promise<BaseBranchResolution> {
  if (await branchExists(cwd, wanted)) return { branch: wanted };

  const seen = new Set([wanted]);
  for (const fallback of fallbacks) {
    if (!fallback || seen.has(fallback)) continue;
    seen.add(fallback);
    if (await branchExists(cwd, fallback)) return { branch: fallback, missing: wanted };
  }
  return { branch: wanted };
}
