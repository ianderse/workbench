/**
 * The base branch choice of the task dialogs, and the task metadata it turns into.
 */
import type { TaskMetadata } from '../../../shared/types';
import { validateNewBranchName, type BranchNameError } from '../../../shared/utils/git-ref-name';

/** Base branch value standing for "whatever the project's default branch is" */
export const PROJECT_DEFAULT_BRANCH = '__project_default__';

/** Base branch value standing for "a branch to create" (its name and start branch are separate fields) */
export const NEW_BASE_BRANCH = '__new_branch__';

export interface BaseBranchChoice {
  /** An existing branch, PROJECT_DEFAULT_BRANCH or NEW_BASE_BRANCH */
  baseBranch: string;
  /** The new branch's name (with NEW_BASE_BRANCH) */
  newBranchName: string;
  /** The branch the new branch starts from: an existing branch or PROJECT_DEFAULT_BRANCH */
  newBranchFrom: string;
  projectDefaultBranch: string;
  isLocalBranch: (branch: string) => boolean;
}

/** The start branch of a new branch, with "project default" turned into the branch it stands for */
export function resolveNewBranchFrom(from: string, projectDefaultBranch: string): string {
  return from === PROJECT_DEFAULT_BRANCH ? projectDefaultBranch : from;
}

/**
 * `baseBranch`, `newBaseBranchFrom` and `useLocalBranch` for a task created with this choice.
 * A new branch is stored by name with its start branch; the main process creates it right before
 * the task's worktree (and skips that when it exists). It is local, so tasks start from it as is.
 */
export function buildBaseBranchMetadata(choice: BaseBranchChoice): Partial<TaskMetadata> {
  const { baseBranch, projectDefaultBranch } = choice;
  if (baseBranch === NEW_BASE_BRANCH) {
    const name = choice.newBranchName.trim();
    const from = resolveNewBranchFrom(choice.newBranchFrom, projectDefaultBranch);
    if (!name) return {};
    return { baseBranch: name, ...(from ? { newBaseBranchFrom: from } : {}), useLocalBranch: true };
  }
  const metadata: Partial<TaskMetadata> = {};
  if (baseBranch === PROJECT_DEFAULT_BRANCH) {
    if (projectDefaultBranch) metadata.baseBranch = projectDefaultBranch;
  } else if (baseBranch) {
    metadata.baseBranch = baseBranch;
    // Set when the user picks a local branch: it keeps gitignored files (.env, configs) by not switching to origin
    if (choice.isLocalBranch(baseBranch)) metadata.useLocalBranch = true;
  }
  return metadata;
}

/** Why the new branch name cannot be used (null when it can, or when "New branch" is not chosen) */
export function getNewBranchNameError(
  choice: Pick<BaseBranchChoice, 'baseBranch' | 'newBranchName'>,
  existingBranches: readonly string[],
): BranchNameError | null {
  if (choice.baseBranch !== NEW_BASE_BRANCH) return null;
  return validateNewBranchName(choice.newBranchName.trim(), existingBranches);
}

/** Whether the choice can be saved: a new branch needs a legal, unused name and a branch to start from */
export function isBaseBranchChoiceValid(
  choice: Pick<BaseBranchChoice, 'baseBranch' | 'newBranchName' | 'newBranchFrom' | 'projectDefaultBranch'>,
  existingBranches: readonly string[],
): boolean {
  if (choice.baseBranch !== NEW_BASE_BRANCH) return true;
  return (
    getNewBranchNameError(choice, existingBranches) === null &&
    !!resolveNewBranchFrom(choice.newBranchFrom, choice.projectDefaultBranch)
  );
}
