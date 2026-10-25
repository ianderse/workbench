/**
 * Task splitting: applying a split (description, new tickets at the top of the Queue, rewired
 * dependents), undo, and the propose flow in the proposals file
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task, TaskMetadata } from '../../shared/types';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../project-store', () => ({ projectStore: {} }));

import {
  applyQueueProposal,
  dismissQueueProposal,
  getSplitStatus,
  readQueueProposals,
  submitTaskSplit,
  undoQueueChange,
  type GroomingDeps,
} from '../queue-grooming';
import { applyTaskSplit } from '../task-split';
import type { SplitProposal } from '../../shared/types/queue-grooming';
import type { NormalizedSplit } from '../../shared/utils/task-split';

let tmp: string;
let project: Project;
let tasks: Task[];
let queued: string[][];
let createFails: boolean;

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

function makeDeps(): GroomingDeps {
  return {
    settleMs: 0,
    getProject: (id) => (id === project.id ? project : undefined),
    getTasks: () => tasks,
    runModel: async () => null,
    updateTask: async (_projectId, taskId, updates) => {
      const task = tasks.find((x) => x.id === taskId)!;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.metadata) task.metadata = { ...task.metadata, ...updates.metadata };
    },
    createTask: async (_projectId, title, description, metadata) => {
      if (createFails) throw new Error('create failed');
      const id = `0${tasks.length + 1}-new${tasks.length + 1}`;
      tasks.push(makeTask(id, 'backlog', { title, description }, metadata));
      return id;
    },
    queueTasks: async (_projectId, ids) => {
      queued.push(ids);
      for (const task of tasks.filter((x) => ids.includes(x.id))) task.status = 'queue';
    },
    archive: (_projectId, ids) => {
      for (const task of tasks.filter((x) => ids.includes(x.id))) task.metadata = { ...task.metadata, archivedAt: 'now' };
    },
    unarchive: (_projectId, ids) => {
      for (const task of tasks.filter((x) => ids.includes(x.id))) delete task.metadata!.archivedAt;
    },
    changed: vi.fn(),
  };
}

const split: NormalizedSplit = {
  keepScope: 'Add the subtract function',
  reason: 'Too large',
  pieces: [
    { title: 'Add divide', description: 'Add divide with tests', reason: 'a' },
    { title: 'Add modulo', description: 'Add modulo with tests', reason: 'b' },
  ],
};

function proposal(): SplitProposal {
  return {
    id: 'prop-1',
    kind: 'split',
    fromTaskId: '007-calc',
    taskId: '007-calc',
    createdAt: new Date().toISOString(),
    reason: split.reason,
    keepScope: split.keepScope,
    pieces: split.pieces,
    origin: 'plan',
  };
}

const find = (id: string) => tasks.find((t) => t.id === id)!;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'task-split-'));
  project = { id: 'p1', name: 'P', path: tmp, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [
    makeTask('007-calc', 'in_progress', {}, { agentOverride: { backend: 'omp' }, mcpConnectors: ['context7'] }),
    makeTask('010-queued', 'queue', {}, { dependsOnTaskIds: ['007-calc', '003-x'] }),
    makeTask('011-planning', 'backlog', {}, { dependsOnTaskIds: ['007-calc'] }),
    makeTask('012-running', 'in_progress', {}, { dependsOnTaskIds: ['007-calc'] }),
    makeTask('013-merged', 'done', {}, { dependsOnTaskIds: ['007-calc'] }),
  ];
  queued = [];
  createFails = false;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('applyTaskSplit', () => {
  it('rewrites the description to the reduced scope, keeps the original and adds a note with real ids', async () => {
    const original = find('007-calc').description;
    const undo = await applyTaskSplit(makeDeps(), 'p1', proposal(), new Date(2026, 9, 24, 12));
    expect(undo).not.toBeNull();
    const task = find('007-calc');
    expect(task.description.startsWith('Add the subtract function')).toBe(true);
    expect(task.description).toContain('<details>');
    expect(task.description).toContain(original);
    const [first, second] = tasks.filter((t) => t.metadata?.splitFrom === '007-calc');
    const expectedNote = `Split on 2026-10-24: moved "Add divide" and "Add modulo" to #${first.id.split('-')[0]} and #${second.id.split('-')[0]}`;
    expect(task.description).toContain(expectedNote);
    const note = task.metadata!.contextNotes!.at(-1)!;
    expect(note.note).toBe(expectedNote);
    expect(note.kind).toBe('split');
    expect(task.metadata!.splitInto).toMatchObject({ taskIds: [first.id, second.id], originalDescription: original });
  });

  it('creates the pieces in the Queue, chained, marked as split children and inheriting the agent pin', async () => {
    await applyTaskSplit(makeDeps(), 'p1', proposal());
    const [first, second] = tasks.filter((t) => t.metadata?.splitFrom === '007-calc');
    expect(queued).toEqual([[first.id, second.id]]);
    expect(first.status).toBe('queue');
    expect(first.metadata).toMatchObject({ dependsOnTaskIds: ['007-calc'], agentOverride: { backend: 'omp' }, mcpConnectors: ['context7'], sourceType: 'manual' });
    expect(second.metadata?.dependsOnTaskIds).toEqual([first.id]);
    expect(first.description).toBe('Add divide with tests');
  });

  it('rewires queued and planning dependents onto the last piece and leaves running and merged tickets alone', async () => {
    await applyTaskSplit(makeDeps(), 'p1', proposal());
    const last = find('007-calc').metadata!.splitInto!.taskIds.at(-1)!;
    expect(find('010-queued').metadata?.dependsOnTaskIds).toEqual([last, '003-x']);
    expect(find('011-planning').metadata?.dependsOnTaskIds).toEqual([last]);
    expect(find('012-running').metadata?.dependsOnTaskIds).toEqual(['007-calc']);
    expect(find('013-merged').metadata?.dependsOnTaskIds).toEqual(['007-calc']);
  });

  it('does not apply to a ticket made by a split, one that split before, or a finished one', async () => {
    find('007-calc').metadata = { splitFrom: '001-big' };
    expect(await applyTaskSplit(makeDeps(), 'p1', proposal())).toBeNull();
    find('007-calc').metadata = { splitInto: { proposalId: 'x', taskIds: [], originalDescription: '', at: '' } };
    expect(await applyTaskSplit(makeDeps(), 'p1', proposal())).toBeNull();
    find('007-calc').metadata = {};
    find('007-calc').status = 'done';
    expect(await applyTaskSplit(makeDeps(), 'p1', proposal())).toBeNull();
    expect(tasks).toHaveLength(5);
  });

  it('takes back the pieces it made when creating one fails', async () => {
    const deps = makeDeps();
    let calls = 0;
    const create = deps.createTask;
    deps.createTask = async (...args) => {
      if (++calls === 2) throw new Error('boom');
      return create(...args);
    };
    await expect(applyTaskSplit(deps, 'p1', proposal())).rejects.toThrow('boom');
    expect(tasks.filter((t) => t.metadata?.splitFrom).every((t) => t.metadata?.archivedAt)).toBe(true);
    expect(find('007-calc').description).toBe('Description of 007-calc');
  });
});

describe('undo of an automatic split', () => {
  it('archives the pieces, restores the description and the dependents', async () => {
    const original = find('007-calc').description;
    const outcome = await submitTaskSplit('p1', '007-calc', split, 'plan', 'auto', makeDeps());
    expect(outcome.outcome).toBe('applied');
    const file = await readQueueProposals(project);
    expect(file.undo).toHaveLength(1);

    const result = await undoQueueChange('p1', file.undo[0].id, makeDeps());
    expect(result).toEqual({ success: true });
    const task = find('007-calc');
    expect(task.description).toBe(original);
    expect(task.metadata?.splitInto).toBeUndefined();
    expect(task.metadata?.contextNotes ?? []).toHaveLength(0);
    expect(tasks.filter((t) => t.metadata?.splitFrom).every((t) => t.metadata?.archivedAt)).toBe(true);
    expect(find('010-queued').metadata?.dependsOnTaskIds).toEqual(['007-calc', '003-x']);
    expect(find('011-planning').metadata?.dependsOnTaskIds).toEqual(['007-calc']);
    expect((await readQueueProposals(project)).undo).toHaveLength(0);
  });

  it('refuses, changing nothing, once a new ticket started', async () => {
    await submitTaskSplit('p1', '007-calc', split, 'plan', 'auto', makeDeps());
    const piece = tasks.find((t) => t.metadata?.splitFrom)!;
    piece.status = 'in_progress';
    const entry = (await readQueueProposals(project)).undo[0];
    const result = await undoQueueChange('p1', entry.id, makeDeps());
    expect(result.success).toBe(false);
    expect(result.error).toContain('already started');
    expect(find('007-calc').metadata?.splitInto).toBeDefined();
    expect(piece.metadata?.archivedAt).toBeUndefined();
  });
});

describe('propose flow', () => {
  it('stores the split as a pending proposal without touching any ticket', async () => {
    const outcome = await submitTaskSplit('p1', '007-calc', split, 'plan', 'propose', makeDeps());
    expect(outcome.outcome).toBe('proposed');
    const proposalId = (outcome as { proposalId: string }).proposalId;
    expect(tasks).toHaveLength(5);
    expect(find('007-calc').description).toBe('Description of 007-calc');
    const file = await readQueueProposals(project);
    expect(file.proposals).toHaveLength(1);
    expect(file.proposals[0]).toMatchObject({ kind: 'split', taskId: '007-calc', origin: 'plan' });
    expect(await getSplitStatus('p1', '007-calc', proposalId, makeDeps())).toBe('pending');
  });

  it('keeps one proposal per task', async () => {
    await submitTaskSplit('p1', '007-calc', split, 'plan', 'propose', makeDeps());
    await submitTaskSplit('p1', '007-calc', split, 'plan', 'propose', makeDeps());
    expect((await readQueueProposals(project)).proposals).toHaveLength(1);
  });

  it('Apply splits the ticket and the status becomes applied (the paused task resumes with the reduced scope)', async () => {
    const outcome = await submitTaskSplit('p1', '007-calc', split, 'plan', 'propose', makeDeps());
    const proposalId = (outcome as { proposalId: string }).proposalId;
    const result = await applyQueueProposal('p1', proposalId, makeDeps());
    expect(result).toEqual({ success: true });
    expect(find('007-calc').metadata?.splitInto?.proposalId).toBe(proposalId);
    expect(await getSplitStatus('p1', '007-calc', proposalId, makeDeps())).toBe('applied');
    const file = await readQueueProposals(project);
    expect(file.proposals).toHaveLength(0);
    expect(file.undo).toHaveLength(1);
  });

  it('Dismiss leaves the ticket whole and the status becomes dismissed (the paused task resumes with the full scope)', async () => {
    const outcome = await submitTaskSplit('p1', '007-calc', split, 'plan', 'propose', makeDeps());
    const proposalId = (outcome as { proposalId: string }).proposalId;
    await dismissQueueProposal('p1', proposalId, makeDeps());
    expect(tasks).toHaveLength(5);
    expect(find('007-calc').metadata?.splitInto).toBeUndefined();
    expect(await getSplitStatus('p1', '007-calc', proposalId, makeDeps())).toBe('dismissed');
  });

  it('answers ignored instead of throwing when the split cannot be made', async () => {
    createFails = true;
    const outcome = await submitTaskSplit('p1', '007-calc', split, 'plan', 'auto', makeDeps());
    expect(outcome).toMatchObject({ outcome: 'ignored' });
    expect(find('007-calc').description).toBe('Description of 007-calc');
  });
});
