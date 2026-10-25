/**
 * PR Merger Runner
 * ================
 *
 * Merges a task's GitHub pull request:
 * 1. Check the PR (already merged or closed) and move it to the chosen target branch
 * 2. Pull the target branch into the task branch in its worktree, since other tasks may have
 *    merged changes into it meanwhile; conflicts go to the merge agent (Claude Code), see
 *    `merge-target-into-branch.ts`
 * 3. Push the task branch and merge the PR with `gh pr merge --merge`
 *
 * A failed merge leaves the worktree as it was. All git/gh calls are async.
 */

import { git as runGit } from '../../../utils/git-exec';
import { runTool } from '../../../platform/runtime-exec';
import type { MergeAgentFn } from '../merge-agent';
import { abortOwnWorktreeMerge, inspectWorktreeMerge, mergeTargetIntoBranch } from '../merge-target-into-branch';
import type { AgentBackendKind } from '../../../../shared/types/agent-backend';
import type { MergePRStep, WorktreeMergePRResult } from '../../../../shared/types/task';

export interface MergePRConfig {
  /** Project root directory (main git repo; gh runs here) */
  projectDir: string;
  /** Worktree directory (the task branch is checked out here) */
  worktreePath: string;
  prUrl: string;
  /** Branch to merge into; the PR's current base when omitted */
  targetBranch?: string;
  taskTitle?: string;
  taskDescription?: string;
  /** Claude profile for the merge agent */
  profileId?: string;
  /** The task's effective backend for the merge agent; default: the app-wide backend */
  backend?: AgentBackendKind;
  /** Workbench's data folder, ignored when checking for uncommitted changes */
  dataDir?: string;
  onProgress?: (step: MergePRStep, params?: Record<string, string | number>) => void;
  /** Runs gh (tests replace it) */
  gh?: (args: string[]) => Promise<string>;
  /** Resolves conflicts (tests replace it) */
  mergeAgent?: MergeAgentFn;
}

export type MergePRResult = WorktreeMergePRResult;

interface PullRequestView {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  baseRefName: string;
  headRefName: string;
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/** Merge a task's pull request after pulling its target branch into the task branch */
export async function mergePR(config: MergePRConfig): Promise<MergePRResult> {
  const { worktreePath, prUrl, projectDir, onProgress } = config;
  const git = async (args: string[]) =>
    (await runGit(args, { cwd: worktreePath, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
  const gh = config.gh ?? (async (args: string[]) =>
    (await runTool('gh', args, { cwd: projectDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })).stdout);
  const dataDir = `${(config.dataDir || '.workbench').replace(/\\/g, '/')}/`;

  // 1. The pull request
  onProgress?.('checking');
  let view: PullRequestView;
  try {
    view = JSON.parse(await gh(['pr', 'view', prUrl, '--json', 'state,baseRefName,headRefName'])) as PullRequestView;
  } catch (error) {
    return { success: false, error: `Could not read the pull request: ${errorText(error)}` };
  }
  if (view.state === 'MERGED') return { success: true, alreadyMerged: true, targetBranch: view.baseRefName };
  if (view.state !== 'OPEN') return { success: false, error: 'The pull request is closed' };
  const target = config.targetBranch?.trim() || view.baseRefName;
  const targetRef = `origin/${target}`;

  // A merge Workbench left over from an interrupted attempt starts over; anyone else's merge in
  // progress is refused; other changes must be committed
  const leftover = await inspectWorktreeMerge(worktreePath);
  if (leftover === 'foreign') {
    return { success: false, error: "A merge is in progress in the task's worktree. Finish or abort it before merging." };
  }
  if (leftover === 'own') await abortOwnWorktreeMerge(worktreePath);
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no']))
    .split('\n')
    .filter((line) => line.trim() && !line.slice(3).startsWith(dataDir));
  if (dirty.length) {
    return { success: false, error: "The task's worktree has uncommitted changes. Commit or discard them before merging." };
  }

  if (target !== view.baseRefName) {
    try {
      await gh(['pr', 'edit', prUrl, '--base', target]);
    } catch (error) {
      return { success: false, error: `Could not change the pull request's target branch: ${errorText(error)}` };
    }
  }

  // 2. Pull the target branch into the task branch (Claude Code resolves conflicts)
  onProgress?.('pulling', { target });
  try {
    await git(['fetch', 'origin', target]);
  } catch (error) {
    return { success: false, error: `Could not fetch ${target}: ${errorText(error)}` };
  }
  const merged = await mergeTargetIntoBranch({
    worktreePath,
    branch: view.headRefName,
    targetRef,
    targetName: target,
    taskTitle: config.taskTitle,
    taskDescription: config.taskDescription,
    profileId: config.profileId,
    backend: config.backend,
    onProgress,
    mergeAgent: config.mergeAgent,
  });
  const { conflictedFiles, summary } = merged;
  if (!merged.success) {
    return conflictedFiles.length
      ? { success: false, conflictedFiles, summary, error: merged.error }
      : { success: false, error: merged.error };
  }

  // 3. Push the task branch and merge the PR
  onProgress?.('pushing');
  try {
    await git(['push', 'origin', `HEAD:refs/heads/${view.headRefName}`]);
  } catch (error) {
    return { success: false, conflictedFiles, error: `Could not push ${view.headRefName}: ${errorText(error)}` };
  }
  onProgress?.('merging');
  try {
    await gh(['pr', 'merge', prUrl, '--merge']);
  } catch (error) {
    return { success: false, conflictedFiles, error: `Could not merge the pull request: ${errorText(error)}` };
  }
  return { success: true, targetBranch: target, conflictedFiles, summary };
}
