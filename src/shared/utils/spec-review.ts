/**
 * Spec review loop: pure rules (see shared/types/spec-review.ts)
 *
 *   - `extractSpecPaths()`   spec files a prompt references
 *   - `batchReadiness()`     when a batch gets its Spec review ticket
 *   - `normalizeSpecReview()`validation of the review's structured answer (gaps need evidence)
 *   - `planReviewOutcome()`  what to do with a finished review (round cap, batch status)
 */
import type { Task } from '../types/task';
import type { SpecBatch, SpecBatchStatus, SpecReviewGap, SpecReviewProgressReceipt, SpecReviewReport, SpecReviewSection, SpecSectionStatus } from '../types/spec-review';
import { breakDependencyCycles, sortByDependencies } from './task-breakdown-order';
import { TASK_DECOMPOSITION_GUIDANCE } from './task-decomposition';

export const DEFAULT_MAX_REVIEW_ROUNDS = 2;

/** A cached truthy object alone cannot establish that canonical progress was published. */
export function isSpecReviewProgressReceipt(value: unknown): value is SpecReviewProgressReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(receipt.commit)
    && typeof receipt.branch === 'string' && !!receipt.branch.trim() && !/[\x00-\x20\x7f]/.test(receipt.branch)
    && typeof receipt.reportDigest === 'string' && /^[a-f0-9]{64}$/i.test(receipt.reportDigest)
    && typeof receipt.reviewedAt === 'string' && Number.isFinite(Date.parse(receipt.reviewedAt))
    && (receipt.reviewedRevision === undefined || (typeof receipt.reviewedRevision === 'string' && /^[a-f0-9]{7,64}$/i.test(receipt.reviewedRevision)))
    && typeof receipt.changed === 'boolean';
}
export const MAX_SPEC_GAPS = 12;
const MAX_SPEC_TEXT_CHARS = 20_000;
const PROMPT_EXCERPT_CHARS = 280;

// =============================================================================
// Spec sources
// =============================================================================

/**
 * `docs/...md`-style paths in a prompt: relative or absolute, ending in .md or .mdx, with at least
 * one directory or a directory. URLs are skipped. Order of first appearance, no duplicates.
 */
export function extractSpecPaths(prompt: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s("'`<\[])((?:\.{0,2}\/)?(?:[\w.@~-]+\/)+[\w.@~-]+\.mdx?)(?=$|[\s)"'`>\],;:!?.])/gm;
  for (const match of prompt.matchAll(pattern)) {
    const candidate = match[1];
    const before = prompt.slice(Math.max(0, (match.index ?? 0) - 8), (match.index ?? 0) + 1);
    if (/https?:\/\/\S*$/.test(before + candidate)) continue;
    if (!found.includes(candidate)) found.push(candidate);
  }
  return found;
}

export function promptExcerpt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_EXCERPT_CHARS ? `${flat.slice(0, PROMPT_EXCERPT_CHARS)}...` : flat;
}

/** The copy of the prompt a batch keeps when it is the spec itself */
export function specTextCopy(prompt: string): string {
  return prompt.length > MAX_SPEC_TEXT_CHARS ? prompt.slice(0, MAX_SPEC_TEXT_CHARS) : prompt;
}

/** A short name for the spec: the first file's name without extension, else the start of the prompt */
export function specName(batch: Pick<SpecBatch, 'source' | 'promptExcerpt'>): string {
  const first = batch.source[0];
  if (first) {
    const file = first.split('/').pop() ?? first;
    return file.replace(/\.mdx?$/i, '');
  }
  const text = batch.promptExcerpt.replace(/\.\.\.$/, '');
  return text.length > 60 ? `${text.slice(0, 60).trimEnd()}...` : text || 'spec';
}

// =============================================================================
// Trigger rule
// =============================================================================

/** A ticket that counts as finished for its batch: Done, archived, or in Human Review as completed / auto-merged */
export function isTicketFinished(task: Pick<Task, 'status' | 'reviewReason' | 'metadata'>): boolean {
  if (task.metadata?.archivedAt) return true;
  if (task.status === 'done') return true;
  return task.status === 'human_review' && (task.reviewReason === 'completed' || task.reviewReason === 'auto_merged');
}

export type BatchReadiness = 'ready' | 'waiting' | 'empty';

/**
 * Whether the batch's tickets are all finished. A failed AI review, a stopped or errored ticket
 * keeps the batch waiting. Tickets that were deleted are ignored; a batch with no ticket left is empty.
 */
export function batchReadiness(batch: Pick<SpecBatch, 'taskIds'>, tasks: readonly Task[]): BatchReadiness {
  let seen = 0;
  for (const id of batch.taskIds) {
    const task = tasks.find((t) => t.id === id || t.specId === id);
    if (!task) continue;
    seen += 1;
    if (!isTicketFinished(task)) return 'waiting';
  }
  return seen === 0 ? 'empty' : 'ready';
}

// =============================================================================
// The review's answer
// =============================================================================

export const SPEC_REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    complete: { type: 'boolean', description: 'True only when every spec section is done, no gap is left and the checks were observed' },
    checksObserved: { type: 'boolean', description: "True only when you saw the project's tests (and type check or build) finish in this review and read their results; false when they were not run, did not finish or you only assume the result" },
    summary: { type: 'string', description: 'Two or three sentences for the reviewer' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string', description: 'Spec section, for example "5.2 Save and load"' },
          status: { type: 'string', enum: ['done', 'partial', 'missing'] },
          evidence: { type: 'string', description: 'Files, tests or behaviour that show the status' },
        },
        required: ['section', 'status', 'evidence'],
      },
    },
    gaps: {
      type: 'array',
      maxItems: MAX_SPEC_GAPS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', description: 'Short id such as "g1"' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Self-contained ticket text: what to build, acceptance criteria' },
          specSection: { type: 'string', description: 'The spec section the gap comes from' },
          evidence: { type: 'string', description: 'Concrete proof: a missing test, observed behaviour, a missing file' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of other gaps that must be merged first' },
        },
        required: ['key', 'title', 'description', 'specSection', 'evidence', 'dependsOn'],
      },
    },
  },
  required: ['complete', 'checksObserved', 'summary', 'sections', 'gaps'],
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Clean up the review's answer. A gap needs a title or description, a spec section and evidence;
 * the others are dropped (counted in `droppedGaps`). Gap keys are made unique, unknown and self
 * dependencies dropped (`knownTicketIds`, when given, are the open tickets a gap may also wait for),
 * and cycles broken. The report is complete exactly when no valid gap is left and `checksObserved` is true (an
 * answer without it is not trusted: no gaps then means unverified, see `planReviewOutcome`). Returns null when
 * the answer holds nothing usable.
 */
export function normalizeSpecReview(raw: unknown, knownTicketIds?: ReadonlySet<string>): SpecReviewReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const summary = text(r.summary);

  const sections: SpecReviewSection[] = [];
  if (Array.isArray(r.sections)) {
    for (const item of r.sections) {
      if (!item || typeof item !== 'object') continue;
      const s = item as Record<string, unknown>;
      const section = text(s.section);
      if (!section) continue;
      const status: SpecSectionStatus = s.status === 'done' || s.status === 'missing' ? s.status : 'partial';
      sections.push({ section, status, evidence: text(s.evidence) });
    }
  }

  const gaps: SpecReviewGap[] = [];
  let dropped = 0;
  const used = new Set<string>();
  const keyMap = new Map<string, string>();
  if (Array.isArray(r.gaps)) {
    for (const item of r.gaps.slice(0, MAX_SPEC_GAPS)) {
      if (!item || typeof item !== 'object') continue;
      const g = item as Record<string, unknown>;
      const title = text(g.title).replace(/\.$/, '');
      const description = text(g.description);
      const specSection = text(g.specSection);
      const evidence = text(g.evidence);
      if ((!title && !description) || !specSection || !evidence) {
        dropped += 1;
        continue;
      }
      const original = text(g.key);
      let key = original || `g${gaps.length + 1}`;
      if (used.has(key)) {
        let n = gaps.length + 1;
        while (used.has(`g${n}`)) n += 1;
        key = `g${n}`;
      } else if (original) {
        keyMap.set(original, key);
      }
      used.add(key);
      gaps.push({
        key,
        title: title || description.split('\n')[0].slice(0, 80),
        description: description || title,
        specSection,
        evidence,
        dependsOn: Array.isArray(g.dependsOn) ? g.dependsOn.filter((d): d is string => typeof d === 'string').map((d) => d.trim()) : [],
      });
    }
  }

  if (!summary && sections.length === 0 && gaps.length === 0 && typeof r.complete !== 'boolean') return null;

  for (const gap of gaps) {
    const seen = new Set<string>();
    gap.dependsOn = gap.dependsOn
      .map((d) => keyMap.get(d) ?? d)
      .filter((d) => {
        if (d === gap.key || seen.has(d)) return false;
        if (!used.has(d) && !knownTicketIds?.has(d)) return false;
        seen.add(d);
        return true;
      });
  }
  // Cycles among the gaps only (tickets are not part of the graph)
  const graph = gaps.map((g) => ({ key: g.key, dependsOn: g.dependsOn.filter((d) => used.has(d)), gap: g }));
  breakDependencyCycles(graph);
  for (const node of graph) {
    node.gap.dependsOn = [...node.gap.dependsOn.filter((d) => !used.has(d)), ...node.dependsOn];
  }

  const droppedNote = dropped > 0 ? ` ${dropped} ${dropped === 1 ? 'gap was' : 'gaps were'} left out for missing evidence.` : '';
  const checksObserved = r.checksObserved === true;
  const unverifiedNote = gaps.length === 0 && !checksObserved ? ' Tests were not observed; run them or rerun the review.' : '';
  return {
    complete: gaps.length === 0 && checksObserved,
    checksObserved,
    summary: `${summary}${droppedNote}${unverifiedNote}`.trim(),
    sections,
    gaps: sortByDependencies(gaps),
    ...(dropped > 0 ? { droppedGaps: dropped } : {}),
  };
}

// =============================================================================
// After the review
// =============================================================================

export type ReviewOutcome =
  | { kind: 'complete'; status: SpecBatchStatus }
  | { kind: 'unverified'; status: SpecBatchStatus }
  | { kind: 'create_gaps'; status: SpecBatchStatus; nextRound: number }
  | { kind: 'gaps_open'; status: SpecBatchStatus };

/**
 * What a finished review of `round` leads to: complete when no gap is left; gap tickets of the next
 * round while `round < maxReviewRounds`; otherwise the batch stays open with its gaps. No gaps but checks not
 * observed leaves the batch `unverified` (no new round: the user runs the tests or reruns the review).
 */
export function planReviewOutcome(report: Pick<SpecReviewReport, 'gaps' | 'checksObserved'>, round: number, maxReviewRounds: number): ReviewOutcome {
  if (report.gaps.length === 0) return report.checksObserved === false ? { kind: 'unverified', status: 'unverified' } : { kind: 'complete', status: 'complete' };
  if (round < maxReviewRounds) return { kind: 'create_gaps', status: 'building', nextRound: round + 1 };
  return { kind: 'gaps_open', status: 'gaps_open' };
}

// =============================================================================
// Review ticket text
// =============================================================================

export function reviewTicketTitle(batch: Pick<SpecBatch, 'source' | 'promptExcerpt'>, round: number): string {
  return `Spec review: ${specName(batch)}${round > 0 ? ` (round ${round + 1})` : ''}`;
}

/** The description of a Spec review ticket: the job, the spec, and the tickets that were built from it */
export function buildReviewDescription(
  batch: Pick<SpecBatch, 'source' | 'specText' | 'promptExcerpt' | 'maxReviewRounds'>,
  tickets: ReadonlyArray<{ id: string; title: string }>,
  round: number
): string {
  const spec = batch.source.length > 0
    ? `The spec is in ${batch.source.map((p) => `\`${p}\``).join(', ')}. Read it in full.`
    : `The spec is the prompt the tickets were made from:\n\n<spec>\n${batch.specText || batch.promptExcerpt}\n</spec>`;
  const list = tickets.map((t) => `- ${t.id}: ${t.title}`).join('\n');
  return `Check that the spec is complete as written, now that the tickets built from it are finished. This ticket changes no code.

${spec}

The code of those tickets is on the branch this ticket starts from. Tickets built from the spec:
${list}

How to review:
1. Go through the spec section by section. For each section decide done, partial or missing, and name the evidence (files, tests, behaviour you observed).
2. Run the project's tests (and type check or build when the project has them) and note what fails.
3. List a gap only when you can name the spec section and concrete evidence: a missing test, observed behaviour that differs from the spec, a missing file. Do not list style opinions or ideas beyond the spec. Each gap is a self-contained ticket that a coding agent can build on its own.
4. Workbench publishes the finished report into canonical PROGRESS.md on the reviewed base branch before this ticket completes. Keep the audit read-only; do not edit progress yourself. Its update records the reviewed revision, agent-reported results, remaining gaps and check-observation status, without claiming owner acceptance.

${TASK_DECOMPOSITION_GUIDANCE}
Apply these boundaries only to evidence-backed gaps above; do not create extra work outside the spec to reorganize the project.

This is review ${round + 1} of at most ${batch.maxReviewRounds + 1}${round >= batch.maxReviewRounds ? '; gaps found now stay open for you to decide' : '; gaps found now become new tickets'}.`;
}

/** What happens after a Spec review: tickets to wait for, a closed batch with open gaps, or done */
export type SpecReviewNext =
  | { kind: 'tickets'; taskIds: string[] }
  | { kind: 'gaps_open' }
  | { kind: 'unverified' }
  | { kind: 'complete' };

/**
 * The next step of a finished Spec review, derived from the tasks the renderer already has: the
 * batch's tickets of the next round (`round + 1`) that are not yet in Human Review or Done (the next
 * review is created once they are). Returns null when nothing is known yet (no report, no tickets).
 */
export function deriveSpecReviewNext(
  tasks: Array<Pick<Task, 'id' | 'status' | 'metadata'>>,
  ref: { batchId: string; round: number },
  gapCount: number | undefined,
  checksObserved?: boolean
): SpecReviewNext | null {
  if (gapCount === 0) return checksObserved === false ? { kind: 'unverified' } : { kind: 'complete' };
  const next = tasks
    .filter((x) => x.metadata?.specBatch?.id === ref.batchId && x.metadata.specBatch.round === ref.round + 1)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (next.length > 0) {
    const waiting = next.filter((x) => x.status !== 'human_review' && x.status !== 'done');
    return waiting.length > 0 ? { kind: 'tickets', taskIds: waiting.map((x) => x.id) } : null;
  }
  return gapCount !== undefined ? { kind: 'gaps_open' } : null;
}

/** A string form of the next step, so a Zustand selector returns a stable primitive ('' for none) */
export function specReviewNextKey(next: SpecReviewNext | null): string {
  if (!next) return '';
  return next.kind === 'tickets' ? `tickets:${next.taskIds.join(',')}` : next.kind;
}
