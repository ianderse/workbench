/**
 * Local Merge
 * ===========
 *
 * Merges a task's branch into the base branch chosen for the task with plain git, in the
 * project itself:
 * 1. Both the worktree and the project must have no uncommitted changes
 * 2. The base branch must be the one checked out in the project (git merges into HEAD)
 * 3. The base branch is pulled first when it tracks a remote (fast-forward only; offline or
 *    diverged, it merges as it is and the result carries a note)
 * 4. `git merge-tree` checks for conflicts without touching any working tree
 * 5. Conflicts: the base branch is merged into the task branch in the task's worktree, where the
 *    merge agent (Claude Code) resolves them and the result is checked
 *    (`ai/runners/merge-target-into-branch.ts`)
 * 6. `git merge <task branch>` in the project. Nothing is pushed and no PR is involved
 *
 * A merge that fails is undone (`git merge --abort`, the worktree reset to where it was), so the
 * project stays as it was and the conflicted files are reported. All git calls are async.
 */

import { git as runGit } from '../utils/git-exec';
import { mergeTargetIntoBranch } from '../ai/runners/merge-target-into-branch';
import type { MergeAgentFn } from '../ai/runners/merge-agent';
import type { LocalMergePullNote, LocalMergeStep, WorktreeLocalMergeResult } from '../../shared/types/task';

export interface LocalMergeConfig {
  /** Project root directory (the merge runs here, so the base branch must be checked out) */
  projectDir: string;
  /** Worktree directory (the task branch is checked out here) */
  worktreePath: string;
  /** Branch to merge into: the base branch chosen for the task */
  targetBranch: string;
  /** Workbench's data folder, ignored when checking for uncommitted changes */
  dataDir?: string;
  taskTitle?: string;
  taskDescription?: string;
  /** The project's checks for this task (its triage), for the merge agent to run */
  verificationCommands?: string[];
  /** Claude profile for the merge agent */
  profileId?: string;
  onProgress?: (step: LocalMergeStep, params?: Record<string, string | number>) => void;
  /** Resolves conflicts (tests replace it) */
  mergeAgent?: MergeAgentFn;
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Merge a task's branch into its base branch, locally */
export async function localMerge(config: LocalMergeConfig): Promise<WorktreeLocalMergeResult> {
  const { projectDir, worktreePath, targetBranch, onProgress } = config;
  const run = (cwd: string) => async (args: string[]) =>
    (await runGit(args, { cwd, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
  const git = run(projectDir);
  const worktreeGit = run(worktreePath);
  const dataDir = `${(config.dataDir || '.workbench').replace(/\\/g, '/')}/`;
  /** Changes git would carry into the merge, ignoring Workbench's own task files */
  const uncommitted = async (cwd: (args: string[]) => Promise<string>) =>
    (await cwd(['status', '--porcelain', '--untracked-files=no']))
      .split('\n')
      .filter((line) => line.trim() && !line.slice(3).startsWith(dataDir));
  const unmergedFiles = async () => lines(await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ''));

  onProgress?.('checking');
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
  const base = { sourceBranch, targetBranch };

  // Anything git has not committed would be left behind, so it has to be dealt with first
  if ((await uncommitted(worktreeGit)).length) {
    return { ...base, success: false, error: "The task's worktree has uncommitted changes. Commit or discard them before merging." };
  }

  // git merges into the checked-out branch, so the project has to be on the base branch
  let projectBranch: string;
  try {
    projectBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (error) {
    return { ...base, success: false, error: `Could not read the project's branch: ${errorText(error)}` };
  }
  if (projectBranch !== targetBranch) {
    return {
      ...base,
      success: false,
      error: `The project is on ${projectBranch || 'no branch'}. Check out ${targetBranch} there to merge into it.`,
    };
  }
  if ((await uncommitted(git)).length) {
    return { ...base, success: false, error: `The project has uncommitted changes on ${targetBranch}. Commit or discard them before merging.` };
  }
  // A merge left over from an interrupted attempt starts over
  if (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)) {
    await git(['merge', '--abort']).catch(() => undefined);
  }

  // Pull the base branch (fast-forward only) when it tracks a remote
  const pullNote = await pullTarget(git, targetBranch, onProgress);
  const result: WorktreeLocalMergeResult = { ...base, success: false, ...(pullNote ? { pullNote } : {}) };

  // Nothing to merge when the base branch already has every commit of the task branch
  const alreadyMerged = await git(['merge-base', '--is-ancestor', sourceBranch, 'HEAD']).then(() => true, () => false);
  if (alreadyMerged) return { ...result, success: true, alreadyMerged: true };

  /** Merge the task branch into the project's base branch; undone when git cannot finish it */
  const mergeInProject = async (): Promise<{ ok: true } | { ok: false; conflictedFiles: string[]; message: string }> => {
    onProgress?.('merging');
    try {
      await git(['merge', '--no-edit', sourceBranch]);
      return { ok: true };
    } catch (error) {
      const conflictedFiles = await unmergedFiles();
      // Leave the project exactly as it was
      await git(['merge', '--abort']).catch(() => undefined);
      return { ok: false, conflictedFiles, message: errorText(error) };
    }
  };
  const mergeFailure = (conflictedFiles: string[], message: string): WorktreeLocalMergeResult => ({
    ...result,
    success: false,
    conflictedFiles,
    error: conflictedFiles.length
      ? `git could not merge ${sourceBranch} into ${targetBranch} on its own. The merge was undone.`
      : `Could not merge ${sourceBranch} into ${targetBranch}: ${message}`,
  });

  // Conflicts, checked without touching a working tree
  onProgress?.('checkingConflicts');
  let conflicts = await findConflicts(git, targetBranch, sourceBranch);
  if (conflicts === null) {
    // git older than 2.38 has no `merge-tree --write-tree`: try the merge itself
    const attempt = await mergeInProject();
    if (attempt.ok) return { ...result, success: true };
    if (attempt.conflictedFiles.length === 0) return mergeFailure([], attempt.message);
    conflicts = attempt.conflictedFiles;
  }

  if (conflicts.length === 0) {
    const attempt = await mergeInProject();
    return attempt.ok ? { ...result, success: true } : mergeFailure(attempt.conflictedFiles, attempt.message);
  }

  // The base branch goes into the task branch first, in the worktree (it shares the project's
  // refs), where Claude Code resolves the conflicts
  const resolved = await mergeTargetIntoBranch({
    worktreePath,
    branch: sourceBranch,
    targetRef: targetBranch,
    targetName: targetBranch,
    taskTitle: config.taskTitle,
    taskDescription: config.taskDescription,
    verificationCommands: config.verificationCommands,
    profileId: config.profileId,
    onProgress,
    mergeAgent: config.mergeAgent,
  });
  if (!resolved.success) {
    return {
      ...result,
      success: false,
      conflictedFiles: resolved.conflictedFiles.length ? resolved.conflictedFiles : conflicts,
      summary: resolved.summary,
      error: `${resolved.error || 'Claude Code could not resolve the conflicts'}\nNothing was merged into ${targetBranch} and the task's branch is as it was.`,
    };
  }

  const attempt = await mergeInProject();
  if (!attempt.ok) {
    return {
      ...result,
      success: false,
      conflictedFiles: attempt.conflictedFiles,
      summary: resolved.summary,
      error: `Could not merge ${sourceBranch} into ${targetBranch} after Claude Code resolved the conflicts: ${attempt.message}. The merge was undone.`,
    };
  }
  return { ...result, success: true, resolvedConflicts: resolved.conflictedFiles, summary: resolved.summary };
}

/**
 * Bring the checked-out base branch up to date with its upstream, fast-forward only. Nothing to
 * do without an upstream; a note when the remote can't be reached or the branches diverged.
 */
async function pullTarget(
  git: (args: string[]) => Promise<string>,
  targetBranch: string,
  onProgress: LocalMergeConfig['onProgress'],
): Promise<LocalMergePullNote | undefined> {
  const upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${targetBranch}@{upstream}`]).catch(() => '')).trim();
  if (!upstream) return undefined;
  onProgress?.('pulling', { target: targetBranch, upstream });

  const remote = (await git(['config', '--get', `branch.${targetBranch}.remote`]).catch(() => '')).trim();
  const mergeRef = (await git(['config', '--get', `branch.${targetBranch}.merge`]).catch(() => '')).trim();
  // A remote upstream is fetched first ('.' is a local branch: nothing to fetch)
  if (remote && remote !== '.' && mergeRef) {
    try {
      await git(['fetch', remote, mergeRef]);
    } catch (error) {
      return { reason: 'fetchFailed', upstream, detail: errorText(error) };
    }
  }
  try {
    await git(['merge', '--ff-only', upstream]);
  } catch (error) {
    return { reason: 'notFastForward', upstream, detail: errorText(error) };
  }
  return undefined;
}

/**
 * Files that would conflict when merging `source` into `target`, from `git merge-tree
 * --write-tree` (exit 1: conflicts; output: the tree id, then the conflicted files). Null when
 * this git can't tell (older than 2.38).
 */
async function findConflicts(git: (args: string[]) => Promise<string>, target: string, source: string): Promise<string[] | null> {
  try {
    await git(['-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', '--no-messages', target, source]);
    return [];
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: unknown };
    const output = lines(String(stdout ?? ''));
    if (code === 1 && /^[0-9a-f]{40,64}$/.test(output[0] ?? '')) return [...new Set(output.slice(1))];
    return null;
  }
}
