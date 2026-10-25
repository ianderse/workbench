/**
 * Decision tickets: the whole flow with injected effects (no Electron, no model)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project, Task, TaskMetadata } from '../../shared/types';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../project-store', () => ({ projectStore: {} }));

import { decideTicket, type DecisionDeps } from '../decision-tickets';

let project: Project;
let tasks: Task[];
let modelAnswer: unknown;
let modelError: Error | null;
let modelPrompts: string[];
let queued: string[][];
let done: string[];
let archived: string[][];

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

function makeDeps(): DecisionDeps {
  return {
    settleMs: 0,
    getProject: (id) => (id === project.id ? project : undefined),
    getTasks: () => tasks,
    runModel: async (input) => {
      modelPrompts.push(input.prompt);
      if (modelError) throw modelError;
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
    markDone: async (_p, id) => {
      done.push(id);
      tasks.find((x) => x.id === id)!.status = 'done';
    },
    archive: (_p, ids) => {
      archived.push(ids);
    },
    unarchive: vi.fn(),
    changed: vi.fn(),
  };
}

const snapshot = () => JSON.stringify(tasks);

beforeEach(() => {
  project = { id: 'p1', name: 'P', path: '/tmp/p', autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [
    makeTask('014-feature', 'done', { claudeRun: { summary: 'Built the mentor loop' } as Task['claudeRun'] }),
    makeTask('015-map', 'queue'),
    makeTask(
      '017-decide',
      'backlog',
      { title: 'Decide whether to add forgetting or debate', description: 'Decide.\n\n**Why this needs a decision:** Scope' },
      { followUpFrom: { taskId: '014-feature', item: 'Maybe more mechanics', needsDecision: true, why: 'Scope' }, dependsOnTaskIds: ['014-feature'], useWorktree: true }
    ),
  ];
  modelAnswer = {
    tickets: [
      { title: 'Add forgetting', description: 'Implement forgetting. Acceptance: x', queue: true },
      { title: 'Add debate', description: 'Implement debate. Acceptance: y', queue: true },
    ],
    decisionRecord: '- forgetting: add\n- debate: add\n- threats: defer',
  };
  modelError = null;
  modelPrompts = [];
  queued = [];
  done = [];
  archived = [];
});

describe('decideTicket: make tickets', () => {
  it('creates and queues tickets, records the decision and moves the ticket to Done', async () => {
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Add forgetting and debate; defer threats' }, makeDeps());

    expect(result.success).toBe(true);
    expect(result.data?.outcome).toBe('tickets');
    expect(result.data?.created).toEqual([
      { taskId: '023-new', queued: true },
      { taskId: '024-new', queued: true },
    ]);
    const created = tasks.filter((t) => t.metadata?.followUpFrom?.item === 'decision');
    expect(created).toHaveLength(2);
    for (const t of created) {
      expect(t.metadata?.followUpFrom).toEqual({ taskId: '017-decide', item: 'decision' });
      expect(t.metadata?.dependsOnTaskIds).toEqual(['014-feature']);
      expect(t.metadata?.useWorktree).toBe(true);
      expect(t.status).toBe('queue');
    }
    expect(queued).toEqual([['023-new', '024-new']]);

    const ticket = tasks.find((t) => t.id === '017-decide')!;
    expect(ticket.description).toContain('## Decision');
    expect(ticket.description).toContain('- threats: defer');
    expect(ticket.description).toContain('Add forgetting and debate; defer threats');
    expect(ticket.metadata?.decision).toMatchObject({ outcome: 'tickets', text: 'Add forgetting and debate; defer threats', ticketIds: ['023-new', '024-new'] });
    expect(done).toEqual(['017-decide']);
    expect(modelPrompts[0]).toContain('Built the mentor loop');
    expect(modelPrompts[0]).toContain('Title 015-map');
  });

  it('keeps a ticket the person only wants planned in Planning', async () => {
    modelAnswer = { tickets: [{ title: 'Plan debate', description: 'Plan only', queue: false }], decisionRecord: '- debate: add, plan only' };
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Just plan debate' }, makeDeps());
    expect(result.data?.created).toEqual([{ taskId: '023-new', queued: false }]);
    expect(queued).toEqual([]);
    expect(tasks.find((t) => t.id === '023-new')?.status).toBe('backlog');
  });

  it('changes nothing when the model fails', async () => {
    modelError = new Error('boom');
    const before = snapshot();
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Add it' }, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(snapshot()).toBe(before);
    expect(done).toEqual([]);
  });

  it('changes nothing when the model gives no usable answer', async () => {
    modelAnswer = null;
    const before = snapshot();
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Add it' }, makeDeps());
    expect(result.success).toBe(false);
    expect(snapshot()).toBe(before);
  });

  it('changes nothing when the answer asks for no work now', async () => {
    modelAnswer = { tickets: [], decisionRecord: '- all: defer' };
    const before = snapshot();
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Later' }, makeDeps());
    expect(result).toMatchObject({ success: true, data: { outcome: 'none', created: [], decisionRecord: '- all: defer' } });
    expect(snapshot()).toBe(before);
  });

  it('needs the person to write something', async () => {
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: '   ' }, makeDeps());
    expect(result.success).toBe(false);
    expect(modelPrompts).toHaveLength(0);
  });

  it('only decides tickets that wait for a decision', async () => {
    const plain = await decideTicket('p1', '015-map', { action: 'tickets', text: 'x' }, makeDeps());
    expect(plain.success).toBe(false);
    tasks.find((t) => t.id === '017-decide')!.metadata!.decision = { text: 'x', at: 'now', outcome: 'tickets' };
    const decided = await decideTicket('p1', '017-decide', { action: 'reject', text: 'x' }, makeDeps());
    expect(decided.success).toBe(false);
  });

  it('is not blocked by the follow-up recursion guard (the person chose to queue)', async () => {
    // The decision ticket is itself a follow-up; its tickets still go to the Queue
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Add both' }, makeDeps());
    expect(result.data?.created.every((c) => c.queued)).toBe(true);
  });
});

describe('decideTicket: not now and reject', () => {
  it('saves the note and keeps the ticket in Planning when deferred', async () => {
    const result = await decideTicket('p1', '017-decide', { action: 'defer', text: 'After launch' }, makeDeps());
    expect(result).toMatchObject({ success: true, data: { outcome: 'deferred' } });
    const ticket = tasks.find((t) => t.id === '017-decide')!;
    expect(ticket.status).toBe('backlog');
    expect(ticket.metadata?.decision).toMatchObject({ outcome: 'deferred', text: 'After launch' });
    expect(ticket.description).toContain('Deferred for now.');
    expect(ticket.description).toContain('After launch');
    expect(modelPrompts).toHaveLength(0);
    expect(done).toEqual([]);
    expect(archived).toEqual([]);
  });

  it('can decide a deferred ticket again', async () => {
    await decideTicket('p1', '017-decide', { action: 'defer', text: 'After launch' }, makeDeps());
    const result = await decideTicket('p1', '017-decide', { action: 'tickets', text: 'Now add both' }, makeDeps());
    expect(result.data?.outcome).toBe('tickets');
    expect(tasks.find((t) => t.id === '017-decide')?.metadata?.decision?.outcome).toBe('tickets');
  });

  it('archives with the reason when rejected', async () => {
    const result = await decideTicket('p1', '017-decide', { action: 'reject', text: 'Out of scope' }, makeDeps());
    expect(result).toMatchObject({ success: true, data: { outcome: 'rejected' } });
    const ticket = tasks.find((t) => t.id === '017-decide')!;
    expect(ticket.metadata?.decision).toMatchObject({ outcome: 'rejected', text: 'Out of scope' });
    expect(ticket.description).toContain('Rejected.');
    expect(archived).toEqual([['017-decide']]);
    expect(modelPrompts).toHaveLength(0);
  });
});
