/**
 * Spec review loop
 *
 * Tickets made by "Break into tasks" belong to a spec batch (`metadata.specBatch`). When every
 * ticket of a batch is finished, one Spec review ticket checks that the spec is complete as
 * written; gaps it finds become new tickets of the same batch (the next round), up to a cap.
 * Batches are kept per project in `.workbench/spec-batches.json`.
 */

/** Set on every ticket of a batch (the tickets from the breakdown and the gap tickets of later rounds) */
export interface TaskSpecBatchRef {
  id: string;
  /** Spec files the prompt referenced (project-relative paths); empty when the prompt itself is the spec */
  source: string[];
  /** 0 for the tickets from the breakdown, 1 for the gap tickets of the first review, ... */
  round: number;
}

/** Set on a Spec review ticket */
export interface TaskSpecReviewRef {
  batchId: string;
  /** The batch round whose tickets this review checks */
  round: number;
  /** Gap rounds the batch allows (for "Review 1 of 3" on the card) */
  maxRounds?: number;
}

/** building: tickets are being built; reviewing: a review ticket exists; complete; gaps_open: gaps remain at the cap */
export type SpecBatchStatus = 'building' | 'reviewing' | 'complete' | 'gaps_open';

export interface SpecBatchRound {
  round: number;
  reviewTaskId: string;
  /** Gap tickets this review created (the next round's tickets) */
  gapTaskIds: string[];
  /** Gap key -> ticket id, so a retry after a failure does not create a ticket twice */
  gapKeys?: Record<string, string>;
  /** The review's result was applied (gap tickets created, or the batch closed) */
  processedAt?: string;
}

export interface SpecBatch {
  id: string;
  /** Spec files the prompt referenced; empty when the prompt itself is the spec */
  source: string[];
  /** First characters of the prompt */
  promptExcerpt: string;
  /** Copy of the prompt, kept when it is the spec (no file referenced) */
  specText?: string;
  createdAt: string;
  /** Every ticket of the batch, all rounds */
  taskIds: string[];
  /** Reviews whose result was applied */
  reviewRounds: number;
  /** Rounds of gap tickets allowed (default 2) */
  maxReviewRounds: number;
  /** Round of the tickets being built now */
  round: number;
  status: SpecBatchStatus;
  rounds: SpecBatchRound[];
}

export interface SpecBatchesFile {
  version: 1;
  batches: SpecBatch[];
}

export type SpecSectionStatus = 'done' | 'partial' | 'missing';

export interface SpecReviewSection {
  section: string;
  status: SpecSectionStatus;
  evidence: string;
}

export interface SpecReviewGap {
  /** Id inside the report, so a gap can depend on another gap */
  key: string;
  title: string;
  /** Self-contained ticket text */
  description: string;
  specSection: string;
  /** What shows the gap: a missing test, observed behaviour, a missing file */
  evidence: string;
  /** Keys of other gaps, or ids of open tickets, that must be merged first */
  dependsOn: string[];
}

/** What a Spec review ticket produces (kept in `claude_run.json` as `specReview`) */
export interface SpecReviewReport {
  complete: boolean;
  summary: string;
  sections: SpecReviewSection[];
  gaps: SpecReviewGap[];
  /** Gaps the model listed without a spec section or evidence, which were dropped */
  droppedGaps?: number;
}
