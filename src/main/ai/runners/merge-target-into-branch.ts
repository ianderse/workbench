/**
 * Merge a Target Branch into a Task Branch
 * ========================================
 *
 * The part of merging a task that other tasks make necessary: before the task branch goes into
 * its target, the target (which other tasks may have merged into meanwhile) is merged into the
 * task branch, in the task's worktree:
 * 1. `git merge --no-ff --no-edit <targetRef>`
 * 2. Conflicts go to the merge agent (Claude Code), which resolves and commits them
 * 3. The result is checked: no unmerged paths or conflict markers, the target is part of HEAD,
 *    and every line the target added to the conflicted files survived (else the agent gets a
 *    second pass with the lost lines)
 *
 * A failed merge leaves the worktree as it was. Used by the PR merge (`github/pr-merger.ts`) and
 * the local merge (`worktree/local-merge.ts`). All git calls are async.
 */

import { git as runGit } from '../../utils/git-exec';
import { runMergeAgent, type MergeAgentFn, type MergeAgentInput, type MissingTargetLines } from './merge-agent';

export interface MergeTargetIntoBranchConfig {
  /** Worktree directory (the task branch is checked out here) */
  worktreePath: string;
  /** Task branch (checked out in the worktree) */
  branch: string;
  /** Ref of the target to merge in (e.g. `origin/main`, or a local branch the worktree shares) */
  targetRef: string;
  /** The target's name in messages (e.g. `main`) */
  targetName: string;
  taskTitle?: string;
  taskDescription?: string;
  /** The project's checks for this task, for the merge agent to run */
  verificationCommands?: string[];
  /** Claude profile for the merge agent */
  profileId?: string;
  onProgress?: (step: 'resolving' | 'verifying', params?: Record<string, string | number>) => void;
  /** Resolves conflicts (tests replace it) */
  mergeAgent?: MergeAgentFn;
}

export interface MergeTargetIntoBranchResult {
  success: boolean;
  /** Files that conflicted (resolved by Claude Code when the merge succeeded) */
  conflictedFiles: string[];
  /** Claude Code's account of the conflict resolution */
  summary?: string;
  error?: string;
}

export const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;
/** Target lines too generic to tell whether they survived (braces, punctuation) */
const TRIVIAL_LINE = /^[\s{}()[\];,.]*$/;

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/**
 * Lines the target added to each file (from `mergeBase` to `targetCommit`) that `HEAD` no longer has.
 * Also checks a task session's own merge of its base branch (`task-resync/verify.ts`)
 */
export async function findMissingTargetLines(
  git: (args: string[]) => Promise<string>,
  files: string[],
  mergeBase: string,
  targetCommit: string,
): Promise<MissingTargetLines[]> {
  const missing: MissingTargetLines[] = [];
  for (const file of files) {
    // A literal pathspec: `pages/[id].tsx` is that file, not a pattern that also matches `pages/i.tsx`
    const diff = await git(['--literal-pathspecs', 'diff', '-U0', mergeBase, targetCommit, '--', file]).catch(() => '');
    const added = diff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1).trim())
      .filter((line) => !TRIVIAL_LINE.test(line));
    if (added.length === 0) continue;
    const content = await git(['show', `HEAD:${file}`]).catch(() => '');
    const present = new Set(content.split('\n').map((line) => line.trim()));
    const lost = [...new Set(added.filter((line) => !present.has(line)))];
    if (lost.length) missing.push({ file, lines: lost });
  }
  return missing;
}

/** Merge `targetRef` into the task branch in its worktree, with Claude Code resolving conflicts */
export async function mergeTargetIntoBranch(config: MergeTargetIntoBranchConfig): Promise<MergeTargetIntoBranchResult> {
  const { worktreePath, targetRef, targetName: target, onProgress } = config;
  const git = async (args: string[]) =>
    (await runGit(args, { cwd: worktreePath, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
  const mergeAgent = config.mergeAgent ?? runMergeAgent;
  const isMerging = () => git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);
  /** Paths with conflicts, NUL-separated so names come as they are (never quoted) */
  const unmergedPaths = async () =>
    (await git(['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);

  const before = (await git(['rev-parse', 'HEAD'])).trim();
  // The target's commit, read once: the ref can move while Claude Code works (a commit on the base
  // branch in the project, a fetch), and the checks are about the commit that was merged
  let targetCommit: string;
  try {
    targetCommit = (await git(['rev-parse', '--verify', `${targetRef}^{commit}`])).trim();
  } catch (error) {
    return { success: false, conflictedFiles: [], error: `Could not find ${targetRef}: ${errorText(error)}` };
  }
  const rollback = async () => {
    if (await isMerging()) await git(['merge', '--abort']).catch(() => undefined);
    const head = (await git(['rev-parse', 'HEAD']).catch(() => before)).trim();
    if (head !== before) await git(['reset', '--hard', before]).catch(() => undefined);
  };

  let conflictedFiles: string[] = [];
  const summaries: string[] = [];
  try {
    // By name, so the merge commit's message names the branch
    await git(['merge', '--no-ff', '--no-edit', targetRef]);
  } catch (error) {
    conflictedFiles = await unmergedPaths().catch(() => []);
    if (conflictedFiles.length === 0) {
      await rollback();
      return { success: false, conflictedFiles, error: `Could not merge ${target} into the task branch: ${errorText(error)}` };
    }
    // The commit actually merged, should the ref have moved since it was read
    targetCommit = (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim() || targetCommit;
  }
  if (conflictedFiles.length === 0) return { success: true, conflictedFiles };
  const mergeBase = (await git(['merge-base', before, targetCommit]).catch(() => '')).trim();

  // Conflicts: the merge agent resolves them, then the result is checked
  const agentInput: MergeAgentInput = {
    worktreePath,
    branch: config.branch,
    targetRef,
    conflictedFiles,
    taskTitle: config.taskTitle,
    taskDescription: config.taskDescription,
    verificationCommands: config.verificationCommands,
    profileId: config.profileId,
  };
  try {
    onProgress?.('resolving', { count: conflictedFiles.length, files: conflictedFiles.join(', ') });
    const first = await mergeAgent(agentInput);
    summaries.push(first.summary);
    if (first.status !== 'resolved') throw new Error(`Claude Code could not resolve the conflicts: ${first.summary}`);

    onProgress?.('verifying');
    const unmerged = await unmergedPaths();
    if (unmerged.length) throw new Error(`Conflicts remain in: ${unmerged.join(', ')}`);
    for (const file of conflictedFiles) {
      const content = await git(['show', `:${file}`]).catch(() => git(['show', `HEAD:${file}`]).catch(() => ''));
      if (CONFLICT_MARKER.test(content)) throw new Error(`Conflict markers remain in ${file}`);
    }
    if (await isMerging()) await git(['commit', '--no-edit']);
    await git(['merge-base', '--is-ancestor', targetCommit, 'HEAD']).catch(() => {
      throw new Error(`The merge did not include ${target}`);
    });

    // Every line the target added to the conflicted files must survive
    let missing = mergeBase ? await findMissingTargetLines(git, conflictedFiles, mergeBase, targetCommit) : [];
    if (missing.length) {
      onProgress?.('resolving', { count: missing.length, files: missing.map(({ file }) => file).join(', ') });
      const second = await mergeAgent({ ...agentInput, missingLines: missing });
      summaries.push(second.summary);
      if (second.status !== 'resolved') throw new Error(`Claude Code could not restore the changes from ${target}: ${second.summary}`);
      if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) {
        await git(['add', '-u']);
        await git(['commit', '-m', `Restore changes from ${target} lost in the merge`]);
      }
      const dropped = new Set(second.intentionallyDropped.map(({ file, line }) => `${file}\0${line.trim()}`));
      missing = (await findMissingTargetLines(git, conflictedFiles, mergeBase, targetCommit))
        .map(({ file, lines }) => ({ file, lines: lines.filter((line) => !dropped.has(`${file}\0${line}`)) }))
        .filter(({ lines }) => lines.length);
      if (missing.length) {
        const list = missing.map(({ file, lines }) => `${file}: ${lines.slice(0, 3).join(' | ')}`).join('; ');
        throw new Error(`The merge would lose changes from ${target} (${list})`);
      }
    }
  } catch (error) {
    await rollback();
    return { success: false, conflictedFiles, summary: summaries.join('\n\n') || undefined, error: errorText(error) };
  }
  return { success: true, conflictedFiles, summary: summaries.join('\n\n') || undefined };
}
