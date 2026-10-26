/**
 * Spec review loop: a batch gets one Spec review ticket when all its tickets are finished, the
 * review's gaps become the next round's tickets up to the cap, and the batch status follows
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task, TaskMetadata } from '../../shared/types';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../project-store', () => ({ projectStore: {} }));

import { applySpecReview, evaluateSpecBatch, readSpecBatches, registerSpecBatch, type SpecBatchDeps } from '../spec-batches';

let tmp: string;
let project: Project;
let tasks: Task[];
let queued: string[][];

function makeTask(id: string, status: Task['status'], reviewReason?: Task['reviewReason'], metadata: TaskMetadata = {}, extra: Partial<Task> = {}): Task {
  return {
    id, specId: id, projectId: 'p1', title: `Title ${id}`, description: '', status, reviewReason,
    subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date(), ...extra,
  } as Task;
}

function makeDeps(): SpecBatchDeps {
  return {
    getProject: (id) => (id === project.id ? project : undefined),
    getTasks: () => tasks,
    createTask: async (_p, title, description, metadata) => {
      const id = `${String(tasks.length + 1).padStart(3, '0')}-new`;
      tasks.push(makeTask(id, 'backlog', undefined, metadata, { title, description }));
      return id;
    },
    queueTasks: async (_p, ids) => {
      queued.push(ids);
      for (const t of tasks.filter((x) => ids.includes(x.id))) t.status = 'queue';
    },
    changed: vi.fn(),
  };
}

const reviewTasks = () => tasks.filter((t) => t.metadata?.specReview);
const gap = (key: string, extra: Record<string, unknown> = {}) => ({
  key, title: `Gap ${key}`, description: `Build ${key}`, specSection: '5.2', evidence: 'missing file', dependsOn: [], ...extra,
});

async function setUpBatch(maxReviewRounds?: number) {
  tasks = [
    makeTask('001-a', 'human_review', 'completed', { specBatch: { id: 'b1', source: ['docs/SPEC.md'], round: 0 }, baseBranch: 'main' }),
    makeTask('002-b', 'done', undefined, { specBatch: { id: 'b1', source: ['docs/SPEC.md'], round: 0 } }),
  ];
  await registerSpecBatch('p1', { id: 'b1', prompt: 'Build from docs/SPEC.md', taskIds: ['001-a', '002-b'], maxReviewRounds }, makeDeps());
}

/** The review ticket finished with this report */
function finishReview(report: unknown) {
  const review = reviewTasks().at(-1)!;
  review.status = 'human_review';
  review.reviewReason = 'completed';
  review.claudeRun = { specReview: report } as Task['claudeRun'];
  return review;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'spec-batches-'));
  project = { id: 'p1', name: 'P', path: tmp, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [];
  queued = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('registering', () => {
  it('stores the batch with the spec source and defaults', async () => {
    await setUpBatch();
    const [batch] = (await readSpecBatches(project)).batches;
    expect(batch).toMatchObject({ id: 'b1', source: ['docs/SPEC.md'], taskIds: ['001-a', '002-b'], maxReviewRounds: 2, round: 0, status: 'building', reviewRounds: 0 });
    expect(batch.specText).toBeUndefined();
  });

  it('keeps a copy of the prompt when it is the spec', async () => {
    await registerSpecBatch('p1', { id: 'b2', prompt: 'Build a login page', taskIds: ['x'] }, makeDeps());
    const batch = (await readSpecBatches(project)).batches[0];
    expect(batch.source).toEqual([]);
    expect(batch.specText).toBe('Build a login page');
  });
});

describe('trigger', () => {
  it('creates and queues one review ticket when every ticket is in review or done', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    const [review] = reviewTasks();
    expect(review.title).toBe('Spec review: SPEC');
    expect(review.metadata).toMatchObject({
      specReview: { batchId: 'b1', round: 0, maxRounds: 2 },
      dependsOnTaskIds: ['001-a', '002-b'],
      baseBranch: 'main',
      useLocalBranch: true,
    });
    expect(review.description).toContain('docs/SPEC.md');
    expect(queued).toEqual([[review.id]]);
    expect((await readSpecBatches(project)).batches[0].status).toBe('reviewing');
  });

  it('is idempotent', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    await Promise.all([evaluateSpecBatch('p1', 'b1', makeDeps()), evaluateSpecBatch('p1', 'b1', makeDeps())]);
    expect(reviewTasks()).toHaveLength(1);
  });

  it('waits while a ticket failed, was stopped or still runs', async () => {
    await setUpBatch();
    tasks[0].reviewReason = 'qa_rejected';
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(0);
    tasks[0].reviewReason = 'completed';
    tasks[1].status = 'in_progress';
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(0);
    tasks[1].status = 'done';
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(1);
  });

  it('counts an archived ticket as done', async () => {
    await setUpBatch();
    tasks[1].status = 'queue';
    tasks[1].metadata = { ...tasks[1].metadata, archivedAt: 'x' };
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(1);
  });

  it('respects the project setting', async () => {
    await setUpBatch();
    project.settings = { specReview: false } as Project['settings'];
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(0);
  });

  it('builds the round again when the review ticket was deleted', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    tasks = tasks.filter((t) => !t.metadata?.specReview);
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(1);
  });

  it('derives the batch from its tickets when it was never registered', async () => {
    tasks = [makeTask('001-a', 'done', undefined, { specBatch: { id: 'lost', source: [], round: 0 } })];
    await evaluateSpecBatch('p1', 'lost', makeDeps());
    expect(reviewTasks()).toHaveLength(1);
  });
});

describe('after the review', () => {
  it('closes the batch as complete when the spec is complete', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    finishReview({ complete: true, checksObserved: true, summary: 'All there', sections: [{ section: '1', status: 'done', evidence: 'x' }], gaps: [] });
    await applySpecReview('p1', reviewTasks()[0].id, makeDeps());
    const batch = (await readSpecBatches(project)).batches[0];
    expect(batch.status).toBe('complete');
    expect(batch.reviewRounds).toBe(1);
    expect(tasks.filter((t) => t.metadata?.specBatch && !['001-a', '002-b'].includes(t.id))).toHaveLength(0);
  });

  it('leaves the batch unverified, with no new round, when no gap is left but the checks were not observed, and applies a rerun', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    finishReview({ complete: true, checksObserved: false, summary: 'Looks done', sections: [], gaps: [] });
    await applySpecReview('p1', reviewTasks()[0].id, makeDeps());
    let batch = (await readSpecBatches(project)).batches[0];
    expect(batch.status).toBe('unverified');
    expect(batch.reviewRounds).toBe(1);
    expect(tasks.filter((t) => t.metadata?.specBatch?.round === 1)).toHaveLength(0);
    // The same review ticket reports again, this time with the tests seen
    finishReview({ complete: true, checksObserved: true, summary: 'Tests pass', sections: [], gaps: [] });
    await applySpecReview('p1', reviewTasks()[0].id, makeDeps());
    batch = (await readSpecBatches(project)).batches[0];
    expect(batch.status).toBe('complete');
    expect(batch.reviewRounds).toBe(1);
  });

  it('creates and queues gap tickets of the next round with their dependencies, and building resumes', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    finishReview({ complete: false, summary: 's', sections: [], gaps: [gap('g1'), gap('g2', { dependsOn: ['g1'] })] });
    await applySpecReview('p1', reviewTasks()[0].id, makeDeps());

    const gaps = tasks.filter((t) => t.metadata?.specBatch?.round === 1);
    expect(gaps.map((t) => t.title)).toEqual(['Gap g1', 'Gap g2']);
    expect(gaps[0].description).toContain('Spec section: 5.2');
    expect(gaps[0].description).toContain('Evidence: missing file');
    expect(gaps[1].metadata?.dependsOnTaskIds).toEqual([gaps[0].id]);
    expect(queued.at(-1)).toEqual(gaps.map((t) => t.id));
    const batch = (await readSpecBatches(project)).batches[0];
    expect(batch).toMatchObject({ status: 'building', round: 1, reviewRounds: 1 });
    expect(batch.taskIds).toEqual(expect.arrayContaining(gaps.map((t) => t.id)));
  });

  it('applies a review once', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    finishReview({ complete: false, summary: 's', sections: [], gaps: [gap('g1')] });
    const id = reviewTasks()[0].id;
    await applySpecReview('p1', id, makeDeps());
    await applySpecReview('p1', id, makeDeps());
    expect(tasks.filter((t) => t.metadata?.specBatch?.round === 1)).toHaveLength(1);
  });

  it('runs the next review when the gap tickets finish, and leaves gaps open at the cap', async () => {
    await setUpBatch(1);
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    finishReview({ complete: false, summary: 's', sections: [], gaps: [gap('g1')] });
    await applySpecReview('p1', reviewTasks()[0].id, makeDeps());

    // Round 1 tickets are not finished yet: no second review
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(1);
    const gapTicket = tasks.find((t) => t.metadata?.specBatch?.round === 1)!;
    gapTicket.status = 'human_review';
    gapTicket.reviewReason = 'completed';
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    expect(reviewTasks()).toHaveLength(2);
    expect(reviewTasks()[1].metadata?.specReview).toMatchObject({ round: 1 });
    expect(reviewTasks()[1].title).toBe('Spec review: SPEC (round 2)');

    // The cap (1 round of gap tickets) is reached: the gaps stay open, nothing new is created
    const before = tasks.length;
    finishReview({ complete: false, summary: 's', sections: [], gaps: [gap('g1'), gap('g2')] });
    await applySpecReview('p1', reviewTasks()[1].id, makeDeps());
    expect(tasks).toHaveLength(before);
    expect((await readSpecBatches(project)).batches[0]).toMatchObject({ status: 'gaps_open', reviewRounds: 2 });
  });

  it('does nothing while the review ticket has not completed', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    const review = reviewTasks()[0];
    review.claudeRun = { specReview: { complete: true, summary: 's', sections: [], gaps: [] } } as unknown as Task['claudeRun'];
    review.status = 'human_review';
    review.reviewReason = 'stopped';
    await applySpecReview('p1', review.id, makeDeps());
    expect((await readSpecBatches(project)).batches[0].status).toBe('reviewing');
  });

  it('drops gaps without evidence before creating tickets', async () => {
    await setUpBatch();
    await evaluateSpecBatch('p1', 'b1', makeDeps());
    finishReview({ complete: false, checksObserved: true, summary: 's', sections: [], gaps: [gap('g1', { evidence: '' })] });
    await applySpecReview('p1', reviewTasks()[0].id, makeDeps());
    expect((await readSpecBatches(project)).batches[0].status).toBe('complete');
    expect(tasks.filter((t) => t.metadata?.specBatch?.round === 1)).toHaveLength(0);
  });
});
