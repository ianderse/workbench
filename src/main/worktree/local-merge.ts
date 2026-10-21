/**
 * Local Merge
 * ===========
 *
 * Merges a task's branch into the base branch chosen for the task with plain git, in the
 * project itself:
 * 1. Both the worktree and the project must have no uncommitted changes
 * 2. The base branch must be the one checked out in the project (git merges into HEAD)
 * 3. `git merge <task branch>`, and nothing more: no fetch, no push, no PR
 *
 * A merge git cannot do on its own is undone (`git merge --abort`), so the project stays as it
 * was and the conflicted files are reported. All git calls are async.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getIsolatedGitEnv } from '../utils/git-isolation';
import type { WorktreeLocalMergeResult } from '../../shared/types/task';

const execFileAsync = promisify(execFile);

export interface LocalMergeConfig {
  /** Project root directory (the merge runs here, so the base branch must be checked out) */
  projectDir: string;
  /** Worktree directory (the task branch is checked out here) */
  worktreePath: string;
  /** Branch to merge into: the base branch chosen for the task */
  targetBranch: string;
  gitPath: string;
  /** Workbench's data folder, ignored when checking for uncommitted changes */
  dataDir?: string;
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/** Merge a task's branch into its base branch, locally */
export async function localMerge(config: LocalMergeConfig): Promise<WorktreeLocalMergeResult> {
  const { projectDir, worktreePath, targetBranch } = config;
  const run = (cwd: string) => async (args: string[]) =>
    (await execFileAsync(config.gitPath, args, { cwd, env: getIsolatedGitEnv(), encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
  const git = run(projectDir);
  const worktreeGit = run(worktreePath);
  const dataDir = `${(config.dataDir || '.workbench').replace(/\\/g, '/')}/`;
  /** Changes git would carry into the merge, ignoring Workbench's own task files */
  const uncommitted = async (cwd: (args: string[]) => Promise<string>) =>
    (await cwd(['status', '--porcelain', '--untracked-files=no']))
      .split('\n')
      .filter((line) => line.trim() && !line.slice(3).startsWith(dataDir));

  // The task branch, as its worktree has it checked out
  let sourceBranch: string;
  try {
    sourceBranch = (await worktreeGit(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (error) {
    return { success: false, targetBranch, error: `Could not read the task's branch: ${errorText(error)}` };
  }
  if (!sourceBranch || sourceBranch === 'HEAD') {
    return { success: false, targetBranch, error: "The task's worktree has no branch checked out" };
  }
  const result = { sourceBranch, targetBranch };

  // Anything git has not committed would be left behind, so it has to be dealt with first
  if ((await uncommitted(worktreeGit)).length) {
    return { ...result, success: false, error: "The task's worktree has uncommitted changes. Commit or discard them before merging." };
  }

  // git merges into the checked-out branch, so the project has to be on the base branch
  let projectBranch: string;
  try {
    projectBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (error) {
    return { ...result, success: false, error: `Could not read the project's branch: ${errorText(error)}` };
  }
  if (projectBranch !== targetBranch) {
    return {
      ...result,
      success: false,
      error: `The project is on ${projectBranch || 'no branch'}. Check out ${targetBranch} there to merge into it.`,
    };
  }
  if ((await uncommitted(git)).length) {
    return { ...result, success: false, error: `The project has uncommitted changes on ${targetBranch}. Commit or discard them before merging.` };
  }
  // A merge left over from an interrupted attempt starts over
  if (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)) {
    await git(['merge', '--abort']).catch(() => undefined);
  }

  // Nothing to merge when the base branch already has every commit of the task branch
  const alreadyMerged = await git(['merge-base', '--is-ancestor', sourceBranch, 'HEAD']).then(() => true, () => false);
  if (alreadyMerged) return { ...result, success: true, alreadyMerged: true };

  try {
    await git(['merge', '--no-edit', sourceBranch]);
  } catch (error) {
    const message = errorText(error);
    const conflictedFiles = (await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    // Leave the project exactly as it was
    await git(['merge', '--abort']).catch(() => undefined);
    return {
      ...result,
      success: false,
      conflictedFiles,
      error: conflictedFiles.length
        ? `git could not merge ${sourceBranch} into ${targetBranch} on its own. The merge was undone.`
        : `Could not merge ${sourceBranch} into ${targetBranch}: ${message}`,
    };
  }

  return { ...result, success: true };
}
