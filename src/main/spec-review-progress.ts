import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { SpecReviewProgressReceipt, SpecReviewReport } from '../shared/types/spec-review';
import { advanceBranch, isAncestor, localBranchSha, withTempWorktree } from './autonomous/autonomous-git';
import { git } from './utils/git-exec';

export const SPEC_REVIEW_PROGRESS_MAX_BYTES = 6144;
export const SPEC_REVIEW_PROGRESS_START = '<!--wb:review-->';
export const SPEC_REVIEW_PROGRESS_END = '<!--/wb:review-->';

export interface SpecReviewProgressInput {
  projectPath: string;
  targetBranch: string;
  taskId: string;
  title?: string;
  round?: number;
  /** Revision actually inspected by the reviewer, not the later publication target tip. */
  reviewedRevision?: string;
  reviewedAt: string;
  report: SpecReviewReport;
  signal?: AbortSignal;
}

const writes = new Map<string, Promise<unknown>>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const specReviewProgressDigest = (input: Pick<SpecReviewProgressInput, 'taskId' | 'round' | 'reviewedRevision' | 'reviewedAt' | 'report'>): string => digest({ taskId: input.taskId, round: input.round, reviewedRevision: input.reviewedRevision, reviewedAt: input.reviewedAt, report: input.report });

/** A saved receipt is delivery evidence only while its commit remains on the local target. */
export async function isSpecReviewProgressPublished(projectPath: string, receipt: SpecReviewProgressReceipt): Promise<boolean> {
  try {
    if (!receipt || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(receipt.commit) || typeof receipt.branch !== 'string') return false;
    const target = await localBranchSha(projectPath, receipt.branch);
    return target ? await isAncestor(projectPath, receipt.commit, target) : false;
  } catch {
    return false;
  }
}

const text = (value: string, max: number) => [...value.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()]
  .slice(0, max).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function validate(input: SpecReviewProgressInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.taskId)) throw new Error('Invalid review ticket identity');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.reviewedAt) || !Number.isFinite(Date.parse(input.reviewedAt))) throw new Error('A recorded UTC review completion time is required');
  if (input.reviewedRevision !== undefined && !/^[a-f0-9]{7,64}$/i.test(input.reviewedRevision)) throw new Error('Invalid reviewed revision');
  if (input.round !== undefined && (!Number.isInteger(input.round) || input.round < 0)) throw new Error('Invalid review round');
  const report = input.report;
  if (!report || typeof report.complete !== 'boolean' || typeof report.summary !== 'string'
    || (report.checksObserved !== undefined && typeof report.checksObserved !== 'boolean')
    || !Array.isArray(report.sections) || !Array.isArray(report.gaps)
    || report.sections.some((entry) => !entry || typeof entry.section !== 'string' || !['done', 'partial', 'missing'].includes(entry.status) || typeof entry.evidence !== 'string')
    || report.gaps.some((entry) => !entry || typeof entry.key !== 'string' || typeof entry.title !== 'string' || typeof entry.description !== 'string'
      || typeof entry.specSection !== 'string' || typeof entry.evidence !== 'string' || !Array.isArray(entry.dependsOn) || entry.dependsOn.some((dependency) => typeof dependency !== 'string'))) {
    throw new Error('A usable structured spec-review report is required before updating PROGRESS.md');
  }
  if (report.complete && (report.gaps.length || report.checksObserved !== true || report.sections.some((entry) => entry.status !== 'done'))) {
    throw new Error('The review report claims completion without observed checks and complete sections');
  }
}

function reviewBlockBounds(previous: string): { start: number; end: number } {
  const starts = previous.split(SPEC_REVIEW_PROGRESS_START).length - 1;
  const ends = previous.split(SPEC_REVIEW_PROGRESS_END).length - 1;
  if (starts !== ends || starts > 1) throw new Error('Malformed Workbench review block in PROGRESS.md; preserve it for manual reconciliation');
  const start = previous.indexOf(SPEC_REVIEW_PROGRESS_START);
  const end = previous.indexOf(SPEC_REVIEW_PROGRESS_END);
  if (starts && end < start) throw new Error('Malformed Workbench review block in PROGRESS.md; preserve it for manual reconciliation');
  return { start, end };
}

/** Replace only the managed review block; authored text outside it remains byte-identical. */
export function renderSpecReviewProgress(previous: string, input: SpecReviewProgressInput): string {
  validate(input);
  const { start, end } = reviewBlockBounds(previous);
  const before = start >= 0 ? previous.slice(0, start) : previous;
  const after = start >= 0 ? previous.slice(end + SPEC_REVIEW_PROGRESS_END.length) : '';
  const separator = start < 0 && before && !before.endsWith('\n') ? '\n' : '';
  const { report } = input;
  const revision = input.reviewedRevision?.slice(0, 12) ?? 'unknown';
  const reportTag = specReviewProgressDigest(input).slice(0, 8);
  const checks = report.checksObserved === true ? 'observed' : 'not established';
  const missing = report.sections.filter((entry) => entry.status !== 'done');
  const full = [
    '## Latest spec review',
    `Ticket: ${input.taskId}${input.round === undefined ? '' : `; round ${input.round + 1}`}. Reviewed ${input.reviewedAt}; revision ${revision}; report ${reportTag}.`,
    `Agent-reported result: ${report.complete ? 'spec complete' : report.gaps.length ? `${report.gaps.length} gaps` : 'incomplete/unverified'}; checks ${checks}; sections ${report.sections.filter((entry) => entry.status === 'done').length}/${report.sections.length} done.`,
    text(report.summary, 360),
    ...report.gaps.slice(0, 3).map((gap) => `- ${text(gap.specSection, 70)}: ${text(gap.title, 100)}`),
    ...(report.gaps.length > 3 ? [`${report.gaps.length - 3} further gaps are in the ticket report.`] : []),
    ...(missing.length ? [`Pending sections: ${missing.slice(0, 3).map((entry) => text(entry.section, 60)).join('; ')}${missing.length > 3 ? '; more in report' : ''}.`] : []),
    'This records review evidence, not owner acceptance. Full findings/check evidence remain in the ticket report.',
  ].filter(Boolean).join('\n');
  const number = /^\d+/.exec(input.taskId)?.[0];
  const compactId = number ? `#${number}` : input.taskId;
  const compact = `Review ${compactId}${input.round === undefined ? '' : ` r${input.round + 1}`} ${input.reviewedAt} @${revision} [${reportTag}]: ${report.complete ? 'complete' : 'incomplete'}; ${report.gaps.length} gaps; checks ${report.checksObserved === true ? 'observed' : 'unobserved'}. Not acceptance; see ticket.`;
  for (const body of [full, compact]) {
    const result = `${before}${separator}${SPEC_REVIEW_PROGRESS_START}\n${body}\n${SPEC_REVIEW_PROGRESS_END}${after}${start < 0 && !after ? '\n' : ''}`;
    if (Buffer.byteLength(result, 'utf8') <= SPEC_REVIEW_PROGRESS_MAX_BYTES) return result;
  }
  throw new Error('PROGRESS.md has no room for the bounded review update (6 KiB maximum); compact the authored snapshot and retry this review publication');
}

async function readProgress(directory: string): Promise<string> {
  const file = path.join(directory, 'PROGRESS.md');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PROGRESS.md must be a regular file, not a symlink');
    if (stat.size > SPEC_REVIEW_PROGRESS_MAX_BYTES) throw new Error('PROGRESS.md exceeds 6 KiB; compact the authored snapshot before retrying publication');
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Doc-only publication from the target's latest tip; no checkout switching, user-index writes or pushes. */
export async function publishSpecReviewProgress(input: SpecReviewProgressInput): Promise<SpecReviewProgressReceipt> {
  validate(input);
  const key = `${path.resolve(input.projectPath)}\0${input.targetBranch}`;
  const prior = writes.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(async () => {
    const options = { cwd: input.projectPath, isolated: true, timeout: 30_000, signal: input.signal };
    await git(['check-ref-format', '--branch', input.targetBranch], options);
    const reportDigest = specReviewProgressDigest(input);
    const receipt = (commit: string, changed: boolean): SpecReviewProgressReceipt => ({
      commit, changed, branch: input.targetBranch, reportDigest, reviewedAt: input.reviewedAt,
      ...(input.reviewedRevision ? { reviewedRevision: input.reviewedRevision } : {}),
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      input.signal?.throwIfAborted();
      const base = await localBranchSha(input.projectPath, input.targetBranch);
      if (!base) throw new Error(`Review progress target ${input.targetBranch} is not a local branch`);
      const result = await withTempWorktree(input.projectPath, base, async (directory) => {
        const previous = await readProgress(directory);
        const bounds = reviewBlockBounds(previous);
        // A crash after branch publication but before receipt persistence must not
        // let an older retry replace a later review's single current block.
        const prior = (await git(['log', '-1', '--format=%H%x00%B', '--fixed-strings', `--grep=Workbench-Review-Digest: ${reportDigest}`], { ...options, cwd: directory })).stdout.split('\0');
        const priorPublication = prior[1]?.split('\n').includes(`Workbench-Review-Digest: ${reportDigest}`) ? prior[0].trim() : undefined;
        if (priorPublication && bounds.start >= 0) {
          if (await localBranchSha(input.projectPath, input.targetBranch) !== base) return undefined;
          return { commit: priorPublication, changed: false };
        }
        const currentBlock = previous.slice(bounds.start, bounds.end);
        const publishedAt = /^(?:Ticket: .+ Reviewed |Review \S+(?: r\d+)? )(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)[; ]/m.exec(currentBlock)?.[1];
        if (publishedAt && Date.parse(publishedAt) > Date.parse(input.reviewedAt)) {
          throw new Error('PROGRESS.md records a newer review; the older report is preserved in its ticket and must not replace that snapshot');
        }
        const next = renderSpecReviewProgress(previous, input);
        if (previous === next) {
          const commit = (await git(['log', '-1', '--format=%H', '--', 'PROGRESS.md'], { ...options, cwd: directory })).stdout.trim() || base;
          if (await localBranchSha(input.projectPath, input.targetBranch) !== base) return undefined;
          return { commit, changed: false };
        }
        input.signal?.throwIfAborted();
        await fs.writeFile(path.join(directory, 'PROGRESS.md'), next, { encoding: 'utf8', flag: 'w' });
        await git(['add', '--', 'PROGRESS.md'], { ...options, cwd: directory });
        // Honor the repository's normal clean filters and line-ending policy;
        // hooks must not replace this staged document after it is prepared.
        const expectedProgressBlob = (await git(['rev-parse', ':PROGRESS.md'], { ...options, cwd: directory })).stdout.trim();
        await git(['commit', '-m', `Update PROGRESS.md from spec review ${input.taskId}`, '-m', `Workbench-Review-Digest: ${reportDigest}`], { ...options, cwd: directory });
        const commit = (await git(['rev-parse', 'HEAD'], { ...options, cwd: directory })).stdout.trim();
        // Repository hooks run normally, but their output must still obey this
        // publisher's narrow contract before any canonical branch is advanced.
        const parents = (await git(['rev-list', '--parents', '-n', '1', commit], { ...options, cwd: directory })).stdout.trim().split(' ');
        const changedPaths = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit], { ...options, cwd: directory })).stdout.split('\0').filter(Boolean);
        const committedProgressBlob = (await git(['rev-parse', `${commit}:PROGRESS.md`], { ...options, cwd: directory })).stdout.trim();
        if (parents.length !== 2 || parents[1] !== base || changedPaths.length !== 1 || changedPaths[0] !== 'PROGRESS.md' || committedProgressBlob !== expectedProgressBlob) {
          throw new Error('The review commit changed more than PROGRESS.md or rewrote its rendered snapshot; check repository commit hooks before retrying publication');
        }
        input.signal?.throwIfAborted();
        const error = await advanceBranch(input.projectPath, input.targetBranch, commit, base);
        if (!error) return { commit, changed: true };
        if (await localBranchSha(input.projectPath, input.targetBranch) !== base) return undefined;
        throw new Error(`Could not publish review progress without overwriting checkout work: ${error}`);
      });
      if (result) return receipt(result.commit, result.changed);
    }
    throw new Error('Review progress target kept moving; the review report is preserved, retry publication when the branch settles');
  });
  writes.set(key, run);
  try { return await run; }
  finally { if (writes.get(key) === run) writes.delete(key); }
}
