/**
 * Follow-up tickets: the whole flow with injected effects (no Electron, no model)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project, Task, TaskMetadata } from '../../shared/types';
import type { ReviewSummary } from '../../shared/types/claude-code';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../project-store', () => ({ projectStore: {} }));

import { catchUpFollowUpTickets, createFollowUpTickets, type FollowUpDeps } from '../follow-up-tickets';

let project: Project;
let tasks: Task[];
let modelAnswer: unknown;
let modelPrompts: string[];
let queued: string[][];
let summary: ReviewSummary | null;

function makeTask(id: string, status: Task['status'], extra: Partial<Task> = {}, metadata: TaskMetadata = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: `Title ${id}`,
    description: `Description of ${id}`,
    status,
    subtasks: [],
    logs: [],
    metadata,
    createdAt: new Date('2026-10-01'),
    updatedAt: new Date('2026-10-01'),
    ...extra,
  } as Task;
}

const answer = (...items: Array<Record<string, unknown>>) => ({ items });
const queueItem = { item: 'Add a test for retries', action: 'queue', title: 'Test retries', description: 'Add a unit test for the retry path', why: 'missing test' };
const planningItem = { item: 'Maybe drop the legacy API', action: 'planning', title: 'Drop legacy API', description: 'Decide on removing the legacy API', why: 'It breaks old clients' };

function makeDeps(): FollowUpDeps {
  return {
    settleMs: 0,
    getProject: (id) => (id === project.id ? project : undefined),
    getTasks: () => tasks,
    getReviewSummary: async () => summary,
    runModel: async (input) => {
      modelPrompts.push(input.prompt);
      return modelAnswer;
    },
    updateTask: async (_p, taskId, updates) => {
      const task = tasks.find((x) => x.id === taskId)!;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.metadata) task.metadata = { ...task.metadata, ...updates.metadata };
    },
    createTask: async (_p, title, description, metadata) => {
      const id = `0${20 + tasks.length}-new`;
      tasks.push(makeTask(id, 'backlog', { title, description }, metadata));
      return id;
    },
    queueTasks: async (_p, ids) => {
      queued.push(ids);
      for (const t of tasks.filter((x) => ids.includes(x.id))) t.status = 'queue';
    },
    archive: vi.fn(),
    unarchive: vi.fn(),
    changed: vi.fn(),
  };
}

beforeEach(() => {
  project = { id: 'p1', name: 'P', path: '/tmp/p', autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [
    makeTask('014-feature', 'human_review', { reviewReason: 'completed' }),
    makeTask('015-map', 'queue'),
    makeTask('016-mobs', 'backlog'),
    makeTask('017-running', 'in_progress'),
  ];
  summary = {
    headline: 'Does it',
    whatChanged: ['a'],
    verified: 'ok',
    needsAttention: ['Add a test for retries', 'Maybe drop the legacy API', 'Uses a fixed seed'],
    generatedAt: 'now',
  };
  modelAnswer = answer();
  modelPrompts = [];
  queued = [];
});

describe('createFollowUpTickets', () => {
  it('creates a queued ticket that waits for the source and a Planning ticket with the reason', async () => {
    modelAnswer = answer(queueItem, planningItem, { item: 'Uses a fixed seed', action: 'none', why: 'fyi' });
    const outcome = await createFollowUpTickets('p1', '014-feature', makeDeps());

    expect(outcome?.created.map((c) => c.action)).toEqual(['queue', 'planning']);
    const [q, p] = tasks.slice(-2);
    expect(q.status).toBe('queue');
    expect(p.status).toBe('backlog');
    expect(q.metadata?.dependsOnTaskIds).toEqual(['014-feature']);
    expect(q.metadata?.followUpFrom).toEqual({ taskId: '014-feature', item: 'Add a test for retries' });
    expect(p.metadata?.followUpFrom).toMatchObject({ taskId: '014-feature', needsDecision: true });
    expect(p.description).toContain('**Why this needs a decision:** It breaks old clients');
    expect(queued).toEqual([[q.id]]);
    const source = tasks.find((t) => t.id === '014-feature')!;
    expect(source.metadata?.followUpsCreatedAt).toBeTruthy();
    expect(source.metadata?.followUpTickets).toEqual([{ taskId: q.id, action: 'queue' }, { taskId: p.id, action: 'planning' }]);
  });

  it('offers the open tickets to the model but not the finished one as a ticket', async () => {
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    expect(modelPrompts).toHaveLength(1);
    for (const id of ['015-map', '016-mobs', '017-running']) expect(modelPrompts[0]).toContain(`<ticket id="${id}"`);
    expect(modelPrompts[0]).not.toContain('<ticket id="014-feature"');
  });

  it('adds a note to a covered ticket instead of creating one', async () => {
    modelAnswer = answer({ item: 'Add a test for retries', action: 'covered', coveredBy: '015-map', why: 'its tests include retries' });
    const outcome = await createFollowUpTickets('p1', '014-feature', makeDeps());
    expect(outcome).toEqual({ created: [], coveredCount: 1 });
    expect(tasks).toHaveLength(4);
    const map = tasks.find((t) => t.id === '015-map')!;
    expect(map.description).toContain('**Raised in the review of #014**');
    expect(map.metadata?.contextNotes?.[0]).toMatchObject({ kind: 'followUp', fromTaskId: '014-feature' });
  });

  it('creates nothing for information-only items but still marks the task as handled', async () => {
    modelAnswer = answer({ item: 'Uses a fixed seed', action: 'none', why: 'fyi' });
    const outcome = await createFollowUpTickets('p1', '014-feature', makeDeps());
    expect(outcome).toEqual({ created: [], coveredCount: 0 });
    expect(tasks).toHaveLength(4);
    expect(tasks[0].metadata?.followUpsCreatedAt).toBeTruthy();
  });

  it('only creates Planning tickets for a ticket that is itself a follow-up', async () => {
    tasks[0].metadata = { followUpFrom: { taskId: '010-old', item: 'x' } };
    modelAnswer = answer(queueItem);
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    const created = tasks.at(-1)!;
    expect(created.status).toBe('backlog');
    expect(created.metadata?.followUpFrom?.needsDecision).toBe(true);
    expect(queued).toEqual([]);
  });

  it('handles a task once, even when it enters Human Review again', async () => {
    modelAnswer = answer(queueItem);
    const deps = makeDeps();
    await createFollowUpTickets('p1', '014-feature', deps);
    await createFollowUpTickets('p1', '014-feature', deps);
    expect(modelPrompts).toHaveLength(1);
    expect(tasks.filter((t) => t.metadata?.followUpFrom)).toHaveLength(1);
  });

  it('handles concurrent hook events once', async () => {
    modelAnswer = answer(queueItem);
    const deps = makeDeps();
    await Promise.all([createFollowUpTickets('p1', '014-feature', deps), createFollowUpTickets('p1', '014-feature', deps)]);
    expect(modelPrompts).toHaveLength(1);
  });

  it('does nothing when the project setting is off', async () => {
    project.settings = { followUpTickets: false } as Project['settings'];
    modelAnswer = answer(queueItem);
    expect(await createFollowUpTickets('p1', '014-feature', makeDeps())).toBeNull();
    expect(modelPrompts).toHaveLength(0);
    expect(tasks).toHaveLength(4);
  });

  it('skips Spec review tickets, other states and archived tasks', async () => {
    modelAnswer = answer(queueItem);
    tasks[0].metadata = { specReview: { batchId: 'b', round: 1 } } as unknown as TaskMetadata;
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    tasks[0].metadata = {};
    tasks[0].reviewReason = 'stopped';
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    tasks[0].reviewReason = 'completed';
    tasks[0].status = 'in_progress';
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    tasks[0].status = 'human_review';
    tasks[0].metadata = { archivedAt: 'x' };
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    expect(modelPrompts).toHaveLength(0);
    expect(tasks).toHaveLength(4);
  });

  it('works for auto-merged tasks', async () => {
    tasks[0].reviewReason = 'auto_merged';
    modelAnswer = answer(queueItem);
    const outcome = await createFollowUpTickets('p1', '014-feature', makeDeps());
    expect(outcome?.created).toHaveLength(1);
  });

  it('does nothing and stays retryable when no summary can be had', async () => {
    summary = null;
    expect(await createFollowUpTickets('p1', '014-feature', makeDeps())).toBeNull();
    expect(tasks[0].metadata?.followUpsCreatedAt).toBeUndefined();
  });

  it('skips the model call when the summary has nothing to attend to', async () => {
    summary!.needsAttention = [];
    await createFollowUpTickets('p1', '014-feature', makeDeps());
    expect(modelPrompts).toHaveLength(0);
    expect(tasks[0].metadata?.followUpsCreatedAt).toBeTruthy();
  });

  it('never throws when the model fails', async () => {
    const deps = makeDeps();
    deps.runModel = async () => {
      throw new Error('boom');
    };
    await expect(createFollowUpTickets('p1', '014-feature', deps)).resolves.toBeNull();
  });
});

describe('follow-up marker and startup catch-up', () => {
  const NOW = Date.parse('2026-10-25T12:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  /** A finished run that entered Human Review `entered` ms before NOW */
  function reviewTask(id: string, entered: number, extra: Partial<Task> = {}, metadata: TaskMetadata = {}): Task {
    return makeTask(
      id,
      'human_review',
      {
        reviewReason: 'auto_merged',
        claudeRun: { phases: [{ name: 'validate', startedAt: ago(entered + 60_000), endedAt: ago(entered) }] } as unknown as Task['claudeRun'],
        ...extra,
      },
      metadata
    );
  }
  const catchUp = (deps = makeDeps()) => catchUpFollowUpTickets([project], () => tasks, true, deps, NOW);

  it('creates the follow-ups of a task that reached Human Review before a restart', async () => {
    modelAnswer = answer(queueItem);
    tasks = [reviewTask('018-missed', 60_000, {}, { autoMerge: { sha: 'x', branch: 'main', at: ago(30_000) } })];
    expect(await catchUp()).toBe(1);
    expect(modelPrompts).toHaveLength(1);
    expect(tasks[0].metadata?.followUpsCreatedAt).toBeTruthy();
    expect(tasks.filter((t) => t.metadata?.followUpFrom)).toHaveLength(1);
  });

  it('skips done, old, archived, spec-review, unfinished and already handled tasks', async () => {
    modelAnswer = answer(queueItem);
    tasks = [
      reviewTask('001-done', HOUR, { status: 'done' }),
      reviewTask('002-old', 8 * DAY),
      reviewTask('003-archived', HOUR, {}, { archivedAt: ago(HOUR) }),
      reviewTask('004-spec', HOUR, {}, { specReview: { taskId: 'x' } as unknown as TaskMetadata['specReview'] }),
      reviewTask('005-handled', HOUR, {}, { followUpsCreatedAt: ago(HOUR) }),
      reviewTask('006-unfinished', HOUR, { claudeRun: { phases: [{ name: 'implement', startedAt: ago(HOUR) }] } as unknown as Task['claudeRun'] }),
      reviewTask('007-stopped', HOUR, { reviewReason: 'stopped' }),
      reviewTask('008-running', HOUR, {}, { followUpsStartedAt: ago(60_000) }),
    ];
    expect(await catchUp()).toBe(0);
    expect(modelPrompts).toHaveLength(0);
  });

  it('skips projects with the setting off', async () => {
    project.settings = { followUpTickets: false } as Project['settings'];
    tasks = [reviewTask('018-missed', HOUR)];
    expect(await catchUp()).toBe(0);
  });

  it('retries after an interrupted run, once the started marker is old', async () => {
    modelAnswer = answer(queueItem);
    const deps = makeDeps();
    // First run: the model call dies (the app quit); only the started marker is left
    const failing: FollowUpDeps = { ...deps, runModel: async () => { throw new Error('app quit'); } };
    tasks = [reviewTask('018-missed', HOUR)];
    await createFollowUpTickets('p1', '018-missed', failing);
    expect(tasks[0].metadata?.followUpsStartedAt).toBeTruthy();
    expect(tasks[0].metadata?.followUpsCreatedAt).toBeUndefined();
    // Right away it counts as running: no retry
    expect(await createFollowUpTickets('p1', '018-missed', deps)).toBeNull();
    // A restart later: the marker is old, the catch-up retries
    tasks[0].metadata = { ...tasks[0].metadata, followUpsStartedAt: ago(20 * 60_000) };
    expect(await catchUp(deps)).toBe(1);
    expect(tasks[0].metadata?.followUpsCreatedAt).toBeTruthy();
    expect(tasks.filter((t) => t.metadata?.followUpFrom)).toHaveLength(1);
  });

  it('creates no duplicates when the state hook and the catch-up race', async () => {
    modelAnswer = answer(queueItem);
    const deps = makeDeps();
    tasks = [reviewTask('018-missed', HOUR)];
    await Promise.all([createFollowUpTickets('p1', '018-missed', deps), catchUp(deps)]);
    await catchUp(deps);
    expect(modelPrompts).toHaveLength(1);
    expect(tasks.filter((t) => t.metadata?.followUpFrom)).toHaveLength(1);
  });
});
