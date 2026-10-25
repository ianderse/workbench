/**
 * A task created with "New branch" as its base branch (`metadata.baseBranch` is the new name,
 * `metadata.newBaseBranchFrom` the branch to cut it from) gets that branch made right before its
 * worktree is. Several tasks may name the same branch (a feature branch): the first creates it,
 * the others find it and use it.
 */
import { appLog } from '../app-logger';
import { checkBranchNameSyntax } from '../../shared/utils/git-ref-name';
import { findBaseBranchRef } from './base-branch';
import { git } from './git-exec';

export interface EnsureNewBaseBranchOptions {
  /** Publish a branch this call created to origin (the task's "push new branches" choice) */
  push: boolean;
}

export interface EnsureNewBaseBranchResult {
  created: boolean;
  /** The ref the branch was cut from (set when created) */
  from?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the local branch `name` from `from` unless the repository already has it (locally or on
 * a remote). Throws an error with a message fit for the task's failure when the name is not a
 * legal branch name, `from` does not exist or git refuses.
 */
export async function ensureNewBaseBranch(
  projectPath: string,
  name: string,
  from: string,
  options: EnsureNewBaseBranchOptions,
): Promise<EnsureNewBaseBranchResult> {
  if (await findBaseBranchRef(projectPath, name, { preferLocal: true })) return { created: false };

  const invalid = checkBranchNameSyntax(name);
  if (invalid) {
    const message = `Cannot create the base branch "${name}": it is not a valid branch name (${invalid}). Give the task another branch name.`;
    appLog.error(`[NewBaseBranch] ${message}`);
    throw new Error(message);
  }

  const source = await findBaseBranchRef(projectPath, from, { preferLocal: true });
  if (!source) {
    const message = `Cannot create the base branch "${name}": the branch it should start from, "${from}", does not exist in this repository. Give the task a start branch that exists.`;
    appLog.error(`[NewBaseBranch] ${message}`);
    throw new Error(message);
  }

  try {
    await git(['branch', '--no-track', name, source], { cwd: projectPath, isolated: true });
  } catch (error) {
    // A task started at the same moment may have made it first: then there is nothing to do
    if (await findBaseBranchRef(projectPath, name, { preferLocal: true })) return { created: false };
    const message = `Cannot create the base branch "${name}" from ${source}: ${errorText(error)}`;
    appLog.error(`[NewBaseBranch] ${message}`);
    throw new Error(message);
  }
  appLog.info(`[NewBaseBranch] Created ${name} from ${source} in ${projectPath}`);

  if (options.push) {
    // Best effort, like the task branch's own push: the branch exists locally either way
    try {
      const origin = await git(['remote', 'get-url', 'origin'], { cwd: projectPath, isolated: true }).catch(() => null);
      if (origin?.stdout.trim()) {
        await git(['push', '--set-upstream', 'origin', `refs/heads/${name}:refs/heads/${name}`], {
          cwd: projectPath,
          isolated: true,
          timeout: 120_000,
        });
        appLog.info(`[NewBaseBranch] Pushed ${name} to origin`);
      }
    } catch (error) {
      appLog.warn(`[NewBaseBranch] Could not push ${name}: ${errorText(error)}`);
    }
  }

  return { created: true, from: source };
}
