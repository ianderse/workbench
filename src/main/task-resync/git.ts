/**
 * Git checks around a resync: whether a task's worktree needs its base branch merged in at all,
 * and whether the merge its session made holds up (the same checks as the merge helper,
 * `ai/runners/merge-target-into-branch.ts`). All async.
 */
import { git } from '../utils/git-exec';
import { CONFLICT_MARKER, PARSED_DIFF_FLAGS, filesChangedOnBothSides, findMissingTargetLines } from '../ai/runners/merge-target-into-branch';
import type { MissingTargetLines } from '../ai/runners/merge-agent';
import { resyncRefs, type ResyncRequest, type ResyncTarget } from './request';

function runner(cwd: string) {
  return async (args: string[]) =>
    (await git(args, { cwd, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
}

const succeeds = (promise: Promise<unknown>) => promise.then(() => true, () => false);

/**
 * Where a task's worktree stands against the refs a request merges:
 * - `missing`: none of them can be read
 * - `up-to-date`: its branch already has every readable one
 * - `merging`: a merge is in progress there
 * - `dirty`: uncommitted changes (Workbench's data folder aside)
 * - `no-own-commits`: its branch has no commits of its own, and one ref (the one in `refs`) has
 *   every other ref it lacks, so that ref fast-forwards it
 * - `needed`: its own work and the refs have to be merged
 */
export type ResyncNeed = 'missing' | 'up-to-date' | 'merging' | 'dirty' | 'no-own-commits' | 'needed';

/** Where a task's worktree stands against `refs`; `refs` in the result: the ones it lacks */
export async function inspectResync(worktreePath: string, refs: string | string[], dataDir = '.workbench'): Promise<{ need: ResyncNeed; refs: string[] }> {
  const run = runner(worktreePath);
  const readable: string[] = [];
  for (const ref of typeof refs === 'string' ? [refs] : refs) {
    if (await succeeds(run(['rev-parse', '--verify', '-q', `${ref}^{commit}`]))) readable.push(ref);
  }
  if (readable.length === 0) return { need: 'missing', refs: [] };
  const lacking: string[] = [];
  for (const ref of readable) {
    if (!(await succeeds(run(['merge-base', '--is-ancestor', ref, 'HEAD'])))) lacking.push(ref);
  }
  if (lacking.length === 0) return { need: 'up-to-date', refs: [] };
  if (await succeeds(run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) return { need: 'merging', refs: lacking };
  const data = `${dataDir.replace(/\\/g, '/')}/`;
  const dirty = (await run(['status', '--porcelain', '--untracked-files=no']))
    .split('\n')
    .filter((line) => line.trim() && !line.slice(3).startsWith(data));
  if (dirty.length) return { need: 'dirty', refs: lacking };
  // A fast-forward needs one ref that has HEAD and every other ref it lacks
  for (const ref of lacking) {
    if (!(await succeeds(run(['merge-base', '--is-ancestor', 'HEAD', ref])))) return { need: 'needed', refs: lacking };
  }
  const tip: string[] = [];
  for (const ref of lacking) {
    const others = lacking.filter((other) => other !== ref);
    let hasAll = true;
    for (const other of others) {
      if (!(await succeeds(run(['merge-base', '--is-ancestor', other, ref])))) { hasAll = false; break; }
    }
    if (hasAll) tip.push(ref);
  }
  return tip.length ? { need: 'no-own-commits', refs: [tip[0]] } : { need: 'needed', refs: lacking };
}

/**
 * The commits a request's resync is about: each readable ref's commit now, and the commits an
 * earlier resync merged that were never verified
 */
export async function readResyncTargets(
  worktreePath: string,
  request: Pick<ResyncRequest, 'ref' | 'refs' | 'unverified'>,
): Promise<ResyncTarget[]> {
  const run = runner(worktreePath);
  const targets: ResyncTarget[] = [];
  for (const ref of resyncRefs(request)) {
    const commit = (await run(['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => '')).trim();
    if (commit) targets.push({ ref, commit });
  }
  for (const target of request.unverified ?? []) {
    if (targets.some((t) => t.commit === target.commit)) continue;
    if (await succeeds(run(['cat-file', '-e', `${target.commit}^{commit}`]))) targets.push(target);
  }
  return targets;
}

/** The worktree's HEAD */
export async function readHead(worktreePath: string): Promise<string | undefined> {
  return (await runner(worktreePath)(['rev-parse', 'HEAD']).catch(() => '')).trim() || undefined;
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
 * The task's side of the merge that brought `targetCommit` into HEAD: the first parent of the
 * oldest commit on HEAD's first-parent line that has it (the merge commit), so work the session
 * committed right before merging counts as the task's. Undefined when `targetCommit` came in on
 * that line itself (a fast-forward: no work of the task's own to merge with)
 */
async function ourSideOf(run: (args: string[]) => Promise<string>, targetCommit: string): Promise<string | undefined> {
  const first = (await run(['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${targetCommit}..HEAD`]).catch(() => ''))
    .split('\n').map((line) => line.trim()).find(Boolean);
  if (!first) return undefined;
  const parent = (await run(['rev-parse', '-q', '--verify', `${first}^1`]).catch(() => '')).trim();
  if (!parent || parent === targetCommit || await succeeds(run(['merge-base', '--is-ancestor', parent, targetCommit]))) return undefined;
  return parent;
}

/**
 * Check a merge of `targetCommit` into the worktree's branch: no merge left unfinished, no
 * unmerged paths or conflict markers, `targetCommit` part of HEAD, and every line the target added
 * to the files both sides changed (renames followed) still there (`dropped` lines excepted: the
 * session said why they had to go). The task's side is read from the merge commit; `before` (HEAD
 * before the merge) is the fallback when HEAD has no such merge commit (the target came in some
 * other way)
 */
export async function verifyResync(
  worktreePath: string,
  params: { targetCommit: string; name: string; before?: string; dropped?: Array<{ file: string; line: string }> },
): Promise<ResyncCheck> {
  const run = runner(worktreePath);
  const problems: string[] = [];
  const unmerged = (await run(['diff', ...PARSED_DIFF_FLAGS, '--name-only', '-z', '--diff-filter=U']).catch(() => '')).split('\0').filter(Boolean);
  if (unmerged.length) problems.push(`Conflicts are not resolved in: ${unmerged.join(', ')}`);
  if (await succeeds(run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) {
    problems.push('The merge is not finished: resolve what is left and commit it');
  }
  if (!(await succeeds(run(['merge-base', '--is-ancestor', params.targetCommit, 'HEAD'])))) {
    problems.push(`\`${params.name}\` is not merged into the branch: HEAD does not contain ${params.targetCommit.slice(0, 12)}`);
    return { ok: false, problems, missing: [] };
  }

  const head = (await run(['rev-parse', 'HEAD']).catch(() => '')).trim();
  const ours = (await ourSideOf(run, params.targetCommit))
    ?? (params.before && params.before !== head ? params.before : undefined);
  if (!ours) return { ok: problems.length === 0, problems, missing: [] };
  // The files both sides changed since they parted: where conflicts were, and lines can be lost
  const mergeBase = (await run(['merge-base', ours, params.targetCommit]).catch(() => '')).trim();
  if (!mergeBase) return { ok: problems.length === 0, problems, missing: [] };
  const both = await filesChangedOnBothSides(run, mergeBase, ours, params.targetCommit);

  for (const file of both) {
    const content = await run(['show', `HEAD:${file.path}`]).catch(() => '');
    if (!CONFLICT_MARKER.test(content)) continue;
    // A file that holds such lines on its own (a test about conflicts) is not a leftover
    const own = await Promise.all([`${ours}:${file.ours}`, `${params.targetCommit}:${file.theirs}`].map((spec) => run(['show', spec]).catch(() => '')));
    if (!own.some((text) => CONFLICT_MARKER.test(text))) problems.push(`Conflict markers remain in ${file.path}`);
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

/** Check the merge of every target (the problems of all of them together) */
export async function verifyResyncTargets(
  worktreePath: string,
  targets: ResyncTarget[],
  options: { before?: string; dropped?: Array<{ file: string; line: string }> } = {},
): Promise<ResyncCheck> {
  const problems: string[] = [];
  const missing: MissingTargetLines[] = [];
  for (const target of targets) {
    const check = await verifyResync(worktreePath, { targetCommit: target.commit, name: target.ref, before: options.before, dropped: options.dropped });
    for (const problem of check.problems) if (!problems.includes(problem)) problems.push(problem);
    for (const entry of check.missing) {
      const known = missing.find((m) => m.file === entry.file);
      if (known) known.lines = [...new Set([...known.lines, ...entry.lines])];
      else missing.push({ ...entry });
    }
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
