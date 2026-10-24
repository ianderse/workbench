/**
 * Git checks around a resync: whether a task's worktree needs its base branch merged in at all,
 * and whether the merge its session made holds up (the same checks as the merge helper,
 * `ai/runners/merge-target-into-branch.ts`). All async.
 */
import { git } from '../utils/git-exec';
import { CONFLICT_MARKER, findMissingTargetLines } from '../ai/runners/merge-target-into-branch';
import type { MissingTargetLines } from '../ai/runners/merge-agent';

function runner(cwd: string) {
  return async (args: string[]) =>
    (await git(args, { cwd, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
}

const succeeds = (promise: Promise<unknown>) => promise.then(() => true, () => false);

/**
 * Where a task's worktree stands against `ref`:
 * - `missing`: `ref` can't be read
 * - `up-to-date`: its branch already has `ref`
 * - `merging`: a merge is in progress there
 * - `dirty`: uncommitted changes (Workbench's data folder aside)
 * - `no-own-commits`: its branch has no commits `ref` lacks, so `ref` fast-forwards it
 * - `needed`: its own work and `ref` have to be merged
 */
export type ResyncNeed = 'missing' | 'up-to-date' | 'merging' | 'dirty' | 'no-own-commits' | 'needed';

export async function inspectResync(worktreePath: string, ref: string, dataDir = '.workbench'): Promise<ResyncNeed> {
  const run = runner(worktreePath);
  if (!(await succeeds(run(['rev-parse', '--verify', '-q', `${ref}^{commit}`])))) return 'missing';
  if (await succeeds(run(['merge-base', '--is-ancestor', ref, 'HEAD']))) return 'up-to-date';
  if (await succeeds(run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) return 'merging';
  const data = `${dataDir.replace(/\\/g, '/')}/`;
  const dirty = (await run(['status', '--porcelain', '--untracked-files=no']))
    .split('\n')
    .filter((line) => line.trim() && !line.slice(3).startsWith(data));
  if (dirty.length) return 'dirty';
  const own = Number((await run(['rev-list', '--count', `${ref}..HEAD`])).trim());
  return own === 0 ? 'no-own-commits' : 'needed';
}

/** The commit `ref` names now, and the worktree's HEAD (read before the session merges) */
export async function readResyncStart(worktreePath: string, ref: string): Promise<{ targetCommit: string; before: string } | undefined> {
  const run = runner(worktreePath);
  try {
    const targetCommit = (await run(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    const before = (await run(['rev-parse', 'HEAD'])).trim();
    return { targetCommit, before };
  } catch {
    return undefined;
  }
}

/** Whether the worktree's HEAD has `commit` */
export async function hasCommit(worktreePath: string, commit: string): Promise<boolean> {
  return succeeds(runner(worktreePath)(['merge-base', '--is-ancestor', commit, 'HEAD']));
}

export interface ResyncCheck {
  ok: boolean;
  /** What is wrong, in plain words for the session and the log */
  problems: string[];
  /** Lines the target added that the merge lost */
  missing: MissingTargetLines[];
}

/**
 * Check a session's merge of `targetCommit` into the branch that was at `before`: no merge left
 * unfinished, no unmerged paths or conflict markers, `targetCommit` part of HEAD, and every line
 * the target added to the files both sides changed still there (`dropped` lines excepted: the
 * session said why they had to go)
 */
export async function verifyResync(
  worktreePath: string,
  params: { before: string; targetCommit: string; name: string; dropped?: Array<{ file: string; line: string }> },
): Promise<ResyncCheck> {
  const run = runner(worktreePath);
  const problems: string[] = [];
  const unmerged = (await run(['diff', '--name-only', '-z', '--diff-filter=U']).catch(() => '')).split('\0').filter(Boolean);
  if (unmerged.length) problems.push(`Conflicts are not resolved in: ${unmerged.join(', ')}`);
  if (await succeeds(run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) {
    problems.push('The merge is not finished: resolve what is left and commit it');
  }
  if (!(await succeeds(run(['merge-base', '--is-ancestor', params.targetCommit, 'HEAD'])))) {
    problems.push(`\`${params.name}\` is not merged into the branch: HEAD does not contain ${params.targetCommit.slice(0, 12)}`);
    return { ok: false, problems, missing: [] };
  }

  // The files both sides changed since they parted: where conflicts were, and lines can be lost
  const mergeBase = (await run(['merge-base', params.before, params.targetCommit]).catch(() => '')).trim();
  if (!mergeBase) return { ok: problems.length === 0, problems, missing: [] };
  const changed = async (from: string, to: string) =>
    new Set((await run(['diff', '--name-only', '-z', from, to]).catch(() => '')).split('\0').filter(Boolean));
  const theirs = await changed(mergeBase, params.targetCommit);
  const ours = await changed(mergeBase, params.before);
  const both = [...theirs].filter((file) => ours.has(file));

  for (const file of both) {
    const content = await run(['show', `HEAD:${file}`]).catch(() => '');
    if (!CONFLICT_MARKER.test(content)) continue;
    // A file that holds such lines on its own (a test about conflicts) is not a leftover
    const own = await Promise.all([params.before, params.targetCommit].map((rev) => run(['show', `${rev}:${file}`]).catch(() => '')));
    if (!own.some((text) => CONFLICT_MARKER.test(text))) problems.push(`Conflict markers remain in ${file}`);
  }
  const dropped = new Set((params.dropped ?? []).map(({ file, line }) => `${file}\0${line.trim()}`));
  const missing = (await findMissingTargetLines(run, both, mergeBase, params.targetCommit))
    .map(({ file, lines }) => ({ file, lines: lines.filter((line) => !dropped.has(`${file}\0${line}`)) }))
    .filter(({ lines }) => lines.length > 0);
  if (missing.length) {
    problems.push(`The merge lost changes from \`${params.name}\` in ${missing.map(({ file }) => file).join(', ')}`);
  }
  return { ok: problems.length === 0, problems, missing };
}

/** Undo a merge left unfinished (conflicts the session could not resolve) */
export async function abortUnfinishedMerge(worktreePath: string): Promise<void> {
  const run = runner(worktreePath);
  if (await succeeds(run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) {
    await run(['merge', '--abort']).catch(() => undefined);
  }
}
