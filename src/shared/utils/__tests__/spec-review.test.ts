import { describe, it, expect } from 'vitest';
import {
  batchReadiness,
  buildReviewDescription,
  deriveSpecReviewNext,
  specReviewNextKey,
  extractSpecPaths,
  isTicketFinished,
  normalizeSpecReview,
  planReviewOutcome,
  reviewTicketTitle,
  specName,
} from '../spec-review';
import type { Task } from '../../types/task';
import { TASK_DECOMPOSITION_GUIDANCE } from '../task-decomposition';

const task = (id: string, status: Task['status'], reviewReason?: Task['reviewReason'], metadata: Task['metadata'] = {}): Task =>
  ({ id, specId: id, projectId: 'p', title: id, description: '', status, reviewReason, subtasks: [], logs: [], metadata }) as unknown as Task;

describe('spec gap decomposition', () => {
  it('carries the same boundaries into review tickets without expanding beyond evidenced gaps', () => {
    const description = buildReviewDescription({
      source: ['docs/SPEC.md'], promptExcerpt: 'Build', maxReviewRounds: 2,
    }, [{ id: '001-a', title: 'Foundation' }], 0);
    expect(description).toContain(TASK_DECOMPOSITION_GUIDANCE);
    expect(description).toContain('only to evidence-backed gaps');
    expect(description).toContain('docs/SPEC.md');
    expect(description).toContain('001-a: Foundation');
  });
});

describe('extractSpecPaths', () => {
  it('finds docs-style markdown paths, once each, and skips bare names and urls', () => {
    const prompt = 'Build the CLI from docs/SLICE_01_SPEC.md (v0.2). See also "./notes/plan.md", docs/SLICE_01_SPEC.md and CLAUDE.md, https://example.com/docs/x.md.';
    expect(extractSpecPaths(prompt)).toEqual(['docs/SLICE_01_SPEC.md', './notes/plan.md']);
  });

  it('allows a path at the end of a sentence', () => {
    expect(extractSpecPaths('Implement docs/spec.md.')).toEqual(['docs/spec.md']);
  });

  it('finds nothing in a prompt that is the spec itself', () => {
    expect(extractSpecPaths('Build a login page with email and password.')).toEqual([]);
  });
});

describe('trigger rule', () => {
  it('counts Done, archived and completed or auto-merged Human Review tickets as finished', () => {
    expect(isTicketFinished(task('a', 'done'))).toBe(true);
    expect(isTicketFinished(task('a', 'queue', undefined, { archivedAt: 'x' }))).toBe(true);
    expect(isTicketFinished(task('a', 'human_review', 'completed'))).toBe(true);
    expect(isTicketFinished(task('a', 'human_review', 'auto_merged'))).toBe(true);
  });

  it('does not count failed, stopped, errored or running tickets', () => {
    expect(isTicketFinished(task('a', 'human_review', 'qa_rejected'))).toBe(false);
    expect(isTicketFinished(task('a', 'human_review', 'stopped'))).toBe(false);
    expect(isTicketFinished(task('a', 'error'))).toBe(false);
    expect(isTicketFinished(task('a', 'in_progress'))).toBe(false);
    expect(isTicketFinished(task('a', 'pr_created'))).toBe(false);
  });

  it('is ready only when every ticket is finished; a deleted ticket is ignored', () => {
    const batch = { taskIds: ['a', 'b', 'gone'] };
    expect(batchReadiness(batch, [task('a', 'done'), task('b', 'human_review', 'completed')])).toBe('ready');
    expect(batchReadiness(batch, [task('a', 'done'), task('b', 'human_review', 'stopped')])).toBe('waiting');
    expect(batchReadiness(batch, [])).toBe('empty');
  });
});

describe('normalizeSpecReview', () => {
  const gap = (extra: Record<string, unknown> = {}) => ({
    key: 'g1', title: 'Add save', description: 'Build save', specSection: '5.2', evidence: 'No save.ts', dependsOn: [], ...extra,
  });

  it('drops gaps without a spec section or evidence and says so', () => {
    const report = normalizeSpecReview({
      complete: false,
      summary: 'Mostly there.',
      sections: [{ section: '5.2', status: 'missing', evidence: 'none' }],
      gaps: [gap(), gap({ key: 'g2', evidence: '' }), gap({ key: 'g3', specSection: ' ' })],
    })!;
    expect(report.gaps.map((g) => g.key)).toEqual(['g1']);
    expect(report.droppedGaps).toBe(2);
    expect(report.summary).toContain('2 gaps were left out');
    expect(report.complete).toBe(false);
  });

  it('is complete when no valid gap is left, whatever the model claimed', () => {
    const dropped = normalizeSpecReview({ complete: false, checksObserved: true, summary: 's', sections: [], gaps: [gap({ evidence: '' })] })!;
    expect(dropped.complete).toBe(true);
    const claimed = normalizeSpecReview({ complete: true, checksObserved: true, summary: 's', sections: [], gaps: [gap()] })!;
    expect(claimed.complete).toBe(false);
  });

  it('is not complete unless the checks were observed, and says so', () => {
    const missing = normalizeSpecReview({ complete: true, summary: 'All done.', sections: [], gaps: [] })!;
    expect(missing.complete).toBe(false);
    expect(missing.checksObserved).toBe(false);
    expect(missing.summary).toBe('All done. Tests were not observed; run them or rerun the review.');
    const no = normalizeSpecReview({ complete: true, checksObserved: false, summary: 's', sections: [], gaps: [] })!;
    expect(no.complete).toBe(false);
    const seen = normalizeSpecReview({ complete: true, checksObserved: true, summary: 's', sections: [], gaps: [] })!;
    expect(seen).toMatchObject({ complete: true, checksObserved: true });
    expect(seen.summary).toBe('s');
    // Gaps found without seeing the checks still become gaps
    const gaps = normalizeSpecReview({ complete: false, checksObserved: false, summary: 's', sections: [], gaps: [gap()] })!;
    expect(gaps.gaps).toHaveLength(1);
    expect(gaps.summary).toBe('s');
  });

  it('keeps gap and open ticket dependencies, drops unknown and self ones, breaks cycles', () => {
    const report = normalizeSpecReview(
      {
        complete: false,
        summary: 's',
        sections: [],
        gaps: [
          gap({ key: 'g1', dependsOn: ['g2', '007-open', '001-done', 'g1'] }),
          gap({ key: 'g2', title: 'Two', dependsOn: ['g1'] }),
        ],
      },
      new Set(['007-open'])
    )!;
    const byKey = Object.fromEntries(report.gaps.map((g) => [g.key, g.dependsOn]));
    expect(byKey.g1).toEqual(['007-open', 'g2']);
    expect(byKey.g2).toEqual([]);
    expect(report.gaps.map((g) => g.key)).toEqual(['g2', 'g1']);
  });

  it('repairs section statuses and returns null for junk', () => {
    const report = normalizeSpecReview({ complete: true, summary: 'ok', sections: [{ section: 'A', status: 'weird', evidence: 'e' }, { status: 'done' }], gaps: [] })!;
    expect(report.sections).toEqual([{ section: 'A', status: 'partial', evidence: 'e' }]);
    expect(normalizeSpecReview(null)).toBeNull();
    expect(normalizeSpecReview({})).toBeNull();
  });
});

describe('planReviewOutcome', () => {
  const withGaps = { gaps: [{}] } as never;
  it('completes when there are no gaps', () => {
    expect(planReviewOutcome({ gaps: [], checksObserved: true }, 0, 2)).toEqual({ kind: 'complete', status: 'complete' });
  });
  it('is unverified, without a new round, when no gap is left but the checks were not observed', () => {
    expect(planReviewOutcome({ gaps: [], checksObserved: false }, 0, 2)).toEqual({ kind: 'unverified', status: 'unverified' });
    expect(planReviewOutcome({ gaps: [], checksObserved: false }, 2, 2)).toEqual({ kind: 'unverified', status: 'unverified' });
  });
  it('creates gap tickets while below the cap, then leaves the gaps open', () => {
    expect(planReviewOutcome(withGaps, 0, 2)).toEqual({ kind: 'create_gaps', status: 'building', nextRound: 1 });
    expect(planReviewOutcome(withGaps, 1, 2)).toEqual({ kind: 'create_gaps', status: 'building', nextRound: 2 });
    expect(planReviewOutcome(withGaps, 2, 2)).toEqual({ kind: 'gaps_open', status: 'gaps_open' });
  });
});

describe('deriveSpecReviewNext', () => {
  const ref = { batchId: 'b1', round: 0 };
  const ticket = (id: string, status: Task['status'], batchId: string, round: number) =>
    task(id, status, undefined, { specBatch: { id: batchId, source: [], round } });
  const tasks = [
    ticket('037-b', 'queue', 'b1', 1),
    ticket('036-a', 'in_progress', 'b1', 1),
    ticket('038-done', 'done', 'b1', 1),
    ticket('040-other', 'queue', 'b2', 1),
    ticket('041-later', 'queue', 'b1', 2),
  ];

  it('lists the waiting next-round tickets of the batch in order', () => {
    const next = deriveSpecReviewNext(tasks, ref, 2);
    expect(next).toEqual({ kind: 'tickets', taskIds: ['036-a', '037-b'] });
    expect(specReviewNextKey(next)).toBe('tickets:036-a,037-b');
  });
  it('says complete without gaps and gaps_open when no tickets were created', () => {
    expect(deriveSpecReviewNext(tasks, ref, 0)).toEqual({ kind: 'complete' });
    expect(deriveSpecReviewNext(tasks, ref, 0, false)).toEqual({ kind: 'unverified' });
    expect(deriveSpecReviewNext([], ref, 2)).toEqual({ kind: 'gaps_open' });
  });
  it('says nothing when the report is unknown or every ticket is already in review', () => {
    expect(deriveSpecReviewNext([], ref, undefined)).toBeNull();
    expect(deriveSpecReviewNext([ticket('036-a', 'human_review', 'b1', 1)], ref, 1)).toBeNull();
    expect(specReviewNextKey(null)).toBe('');
  });
});

describe('names', () => {
  it('names the review after the spec file or the prompt', () => {
    expect(specName({ source: ['docs/SLICE_01_SPEC.md'], promptExcerpt: 'x' })).toBe('SLICE_01_SPEC');
    expect(reviewTicketTitle({ source: ['docs/A.md'], promptExcerpt: '' }, 0)).toBe('Spec review: A');
    expect(reviewTicketTitle({ source: [], promptExcerpt: 'Build a login page' }, 1)).toBe('Spec review: Build a login page (round 2)');
  });
});
