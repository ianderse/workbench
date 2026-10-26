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
 * the local merge (`worktree/local-merge.ts`), the autonomous auto-merge (`autonomous/autonomous-git.ts`)
 * and a task's resync without a session (`claude-code/task-runner.ts`): the one implementation of
 * "bring the target into the task branch and resolve conflicts". The conflict help goes through the
 * agent backend layer (`runMergeAgent` -> `runClaudeText`) with the task's own backend. All git
 * calls are async.
 */

import { readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { git as runGit } from '../../utils/git-exec';
import type { AgentBackendKind } from '../../../shared/types/agent-backend';
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
  /** The task's effective backend (Claude Code or OMP); default: the app-wide backend */
  backend?: AgentBackendKind;
  onProgress?: (step: 'resolving' | 'verifying', params?: Record<string, string | number>) => void;
  /** Resolves conflicts (tests replace it) */
  mergeAgent?: MergeAgentFn;
  /** Stops the merge agent (the task was stopped); the merge is then undone */
  abortSignal?: AbortSignal;
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
/**
 * Flags for every diff Workbench parses: the user's git config (color.ui=always, an external diff
 * tool, a textconv driver) must not change what the checks read
 */
export const PARSED_DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv'];

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  const stdout = (error as { stdout?: string }).stdout;
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/** A file changed between two commits: its path at the start (`base`) and at the end (`path`) */
export interface ChangedPath {
  base: string;
  path: string;
}

/** The files changed from `from` to `to`, renames detected (a renamed file has two paths) */
export async function changedPaths(git: (args: string[]) => Promise<string>, from: string, to: string): Promise<ChangedPath[]> {
  const out = await git(['diff', ...PARSED_DIFF_FLAGS, '--name-status', '-z', '-M', from, to]).catch(() => '');
  const parts = out.split('\0');
  const changed: ChangedPath[] = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      changed.push({ base: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      changed.push({ base: parts[i + 1], path: parts[i + 1] });
      i += 2;
    }
  }
  return changed.filter((c) => c.base && c.path);
}

/** A file both sides of a merge changed: its path in the merge result, on each side, and at the merge base */
export interface SharedFile {
  /** In the merge result (a side that renamed the file moved it there) */
  path: string;
  ours: string;
  theirs: string;
  base: string;
}

/** The files both `ours` and `theirs` changed since `mergeBase`, matched across renames */
export async function filesChangedOnBothSides(
  git: (args: string[]) => Promise<string>,
  mergeBase: string,
  ours: string,
  theirs: string,
): Promise<SharedFile[]> {
  const mine = new Map((await changedPaths(git, mergeBase, ours)).map((c) => [c.base, c.path]));
  const shared: SharedFile[] = [];
  for (const change of await changedPaths(git, mergeBase, theirs)) {
    const own = mine.get(change.base);
    if (own === undefined) continue;
    shared.push({ base: change.base, ours: own, theirs: change.path, path: change.path !== change.base ? change.path : own });
  }
  return shared;
}

/** The lines a `git diff -U0` adds (hunk lines only: a line `++i` is an added `+i`, not a header) */
function addedLines(diff: string): string[] {
  const added: string[] = [];
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added.push(line.slice(1));
  }
  return added;
}

/**
 * Lines the target added to each file (from `mergeBase` to `targetCommit`) that `HEAD` no longer has.
 * A file is a path (the same on every side) or a `SharedFile` (renamed on a side). Also checks a
 * task session's own merge of its base branch (`task-resync/git.ts`)
 */
export async function findMissingTargetLines(
  git: (args: string[]) => Promise<string>,
  files: Array<string | Omit<SharedFile, 'ours'>>,
  mergeBase: string,
  targetCommit: string,
): Promise<MissingTargetLines[]> {
  const missing: MissingTargetLines[] = [];
  for (const entry of files) {
    const file = typeof entry === 'string' ? { path: entry, theirs: entry, base: entry } : entry;
    // Both of the target's paths, so a rename is diffed as one file; literal pathspecs:
    // `pages/[id].tsx` is that file, not a pattern that also matches `pages/i.tsx`
    const paths = [...new Set([file.base, file.theirs])];
    const diff = await git(['--literal-pathspecs', 'diff', ...PARSED_DIFF_FLAGS, '-U0', '-M', mergeBase, targetCommit, '--', ...paths]).catch(() => '');
    const added = addedLines(diff)
      .map((line) => line.trim())
      .filter((line) => !TRIVIAL_LINE.test(line));
    if (added.length === 0) continue;
    const content = await git(['show', `HEAD:${file.path}`]).catch(() => '');
    const present = new Set(content.split('\n').map((line) => line.trim()));
    const lost = [...new Set(added.filter((line) => !present.has(line)))];
    if (lost.length) missing.push({ file: file.path, lines: lost });
  }
  return missing;
}

// =============================================================================
// Workbench's own merge in a worktree
// =============================================================================

/** Marker in the worktree's git dir while Workbench merges a target into the task branch */
const MERGE_MARKER = 'workbench-merge.json';

interface MergeMarker {
  targetCommit: string;
  before: string;
}

async function markerFile(git: (args: string[]) => Promise<string>, worktreePath: string): Promise<string | undefined> {
  const out = (await git(['rev-parse', '--git-path', MERGE_MARKER]).catch(() => '')).trim();
  return out ? path.resolve(worktreePath, out) : undefined;
}

async function writeMarker(git: (args: string[]) => Promise<string>, worktreePath: string, marker: MergeMarker): Promise<void> {
  const file = await markerFile(git, worktreePath);
  if (file) await writeFile(file, JSON.stringify(marker), 'utf-8').catch(() => undefined);
}

async function removeMarker(git: (args: string[]) => Promise<string>, worktreePath: string): Promise<void> {
  const file = await markerFile(git, worktreePath);
  if (file) await rm(file, { force: true }).catch(() => undefined);
}

/**
 * The merge in progress in a worktree, when Workbench started it (an interrupted merge helper
 * run: the app quit while Claude Code resolved it). `none`: no merge in progress; `foreign`: a
 * merge someone else started, never undone by Workbench
 */
export async function inspectWorktreeMerge(worktreePath: string): Promise<'none' | 'own' | 'foreign'> {
  const git = async (args: string[]) =>
    (await runGit(args, { cwd: worktreePath, isolated: true, encoding: 'utf-8' })).stdout;
  const mergeHead = (await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim();
  if (!mergeHead) return 'none';
  const file = await markerFile(git, worktreePath);
  try {
    const marker = JSON.parse(await readFile(file ?? '', 'utf-8')) as Partial<MergeMarker>;
    return marker.targetCommit === mergeHead ? 'own' : 'foreign';
  } catch {
    return 'foreign';
  }
}

/** Undo Workbench's own interrupted merge in a worktree (`inspectWorktreeMerge` said `own`) */
export async function abortOwnWorktreeMerge(worktreePath: string): Promise<void> {
  const git = async (args: string[]) =>
    (await runGit(args, { cwd: worktreePath, isolated: true, encoding: 'utf-8' })).stdout;
  await git(['merge', '--abort']).catch(() => undefined);
  await removeMarker(git, worktreePath);
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
    (await git(['diff', ...PARSED_DIFF_FLAGS, '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);

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
    if (await isMerging()) {
      await git(['merge', '--abort']).catch(() => undefined);
      // An abort that failed (a lock held by another git process, say) leaves a half-done merge
      if (await isMerging()) await git(['reset', '--merge']).catch(() => undefined);
    }
    const head = (await git(['rev-parse', 'HEAD']).catch(() => before)).trim();
    if (head !== before) await git(['reset', '--hard', before]).catch(() => undefined);
    // The marker stays while a merge is still in progress: without it the leftover reads as
    // someone else's merge, which Workbench never undoes, and the task keeps a dirty worktree
    if (!(await isMerging())) await removeMarker(git, worktreePath);
  };
  // Marks the merge as Workbench's own: one left over from an interrupted run may be undone later
  await writeMarker(git, worktreePath, { targetCommit, before });

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
    await writeMarker(git, worktreePath, { targetCommit, before });
  }
  if (conflictedFiles.length === 0) {
    await removeMarker(git, worktreePath);
    return { success: true, conflictedFiles };
  }
  const mergeBase = (await git(['merge-base', before, targetCommit]).catch(() => '')).trim();
  // The conflicted files as the target has them: a side may have renamed one
  const shared = mergeBase ? await filesChangedOnBothSides(git, mergeBase, before, targetCommit) : [];
  const checkedFiles = conflictedFiles.map((file) =>
    shared.find((s) => s.path === file || s.ours === file || s.theirs === file) ?? file);

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
    backend: config.backend,
    abortSignal: config.abortSignal,
  };
  try {
    onProgress?.('resolving', { count: conflictedFiles.length, files: conflictedFiles.join(', ') });
    const first = await mergeAgent(agentInput);
    if (config.abortSignal?.aborted) throw new Error('Stopped');
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
    let missing = mergeBase ? await findMissingTargetLines(git, checkedFiles, mergeBase, targetCommit) : [];
    if (missing.length) {
      onProgress?.('resolving', { count: missing.length, files: missing.map(({ file }) => file).join(', ') });
      const second = await mergeAgent({ ...agentInput, missingLines: missing });
      if (config.abortSignal?.aborted) throw new Error('Stopped');
      summaries.push(second.summary);
      if (second.status !== 'resolved') throw new Error(`Claude Code could not restore the changes from ${target}: ${second.summary}`);
      if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) {
        await git(['add', '-u']);
        await git(['commit', '-m', `Restore changes from ${target} lost in the merge`]);
      }
      const dropped = new Set(second.intentionallyDropped.map(({ file, line }) => `${file}\0${line.trim()}`));
      missing = (await findMissingTargetLines(git, checkedFiles, mergeBase, targetCommit))
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
  await removeMarker(git, worktreePath);
  return { success: true, conflictedFiles, summary: summaries.join('\n\n') || undefined };
}
