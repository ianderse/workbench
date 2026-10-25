/**
 * Queue grooming after a merge: notes are applied (and can be undone), structural changes become
 * proposals that Apply / Dismiss resolve, and autonomous mode applies them with an undo entry
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task, TaskMetadata } from '../../shared/types';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../project-store', () => ({ projectStore: {} }));

import {
  applyQueueProposal,
  buildGroomingPrompt,
  dismissQueueProposal,
  getQueueProposalsPath,
  groomQueueAfterMerge,
  listQueueProposals,
  readQueueProposals,
  undoContextNote,
  undoQueueChange,
  type GroomingDeps,
} from '../queue-grooming';

let tmp: string;
let project: Project;
let tasks: Task[];
let modelAnswer: unknown;
let modelCalls: Array<{ prompt: string; cwd: string }>;
let created: Array<{ title: string; description: string; metadata: TaskMetadata }>;

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
    runModel: async (input) => {
      modelCalls.push({ prompt: input.prompt, cwd: input.cwd });
      return modelAnswer;
    },
    updateTask: async (_projectId, taskId, updates) => {
      const task = tasks.find((x) => x.id === taskId)!;
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.metadata) task.metadata = { ...task.metadata, ...updates.metadata };
    },
    createTask: async (_projectId, title, description, metadata) => {
      created.push({ title, description, metadata });
      const id = `00${tasks.length + 1}-new`;
      tasks.push(makeTask(id, 'backlog', { title, description }, metadata));
      return id;
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

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'queue-grooming-'));
  project = { id: 'p1', name: 'P', path: tmp, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [
    makeTask('001-prng', 'done', { claudeRun: { summary: 'Added createRng in src/core/prng.ts', plan: 'Plan text' } as Task['claudeRun'] }),
    makeTask('002-map', 'queue', {}, { dependsOnTaskIds: ['001-prng'] }),
    makeTask('003-mobs', 'backlog', {}, { dependsOnTaskIds: ['002-map'] }),
    makeTask('004-loot', 'queue'),
    makeTask('005-ui', 'in_progress'),
    makeTask('006-review', 'human_review'),
  ];
  modelAnswer = { updates: [], newTasks: [] };
  modelCalls = [];
  created = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('groomQueueAfterMerge', () => {
  it('asks the model once with the merged task and only the Planning and Queue tickets, in the project folder', async () => {
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, makeDeps());
    expect(modelCalls).toHaveLength(1);
    const { prompt, cwd } = modelCalls[0];
    expect(cwd).toBe(tmp);
    expect(prompt).toContain('Added createRng in src/core/prng.ts');
    for (const id of ['002-map', '003-mobs', '004-loot']) expect(prompt).toContain(`<ticket id="${id}"`);
    for (const id of ['005-ui', '006-review']) expect(prompt).not.toContain(`<ticket id="${id}"`);
  });

  it('does nothing when the project switched it off or no ticket is waiting', async () => {
    project.settings = { groomQueueAfterMerge: false } as Project['settings'];
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, makeDeps());
    project.settings = {} as Project['settings'];
    tasks = tasks.filter((t) => t.status === 'done' || t.status === 'in_progress');
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, makeDeps());
    expect(modelCalls).toHaveLength(0);
  });

  it('adds a note to the ticket description and metadata, and undo takes it out again', async () => {
    modelAnswer = { updates: [{ taskId: '002-map', kind: 'note', note: 'Use createRng(seed) from src/core/prng.ts', reason: 'merged' }], newTasks: [] };
    const deps = makeDeps();
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);

    const map = tasks.find((t) => t.id === '002-map')!;
    expect(map.description).toContain('Description of 002-map');
    expect(map.description).toContain('**Update after #001 merged**');
    expect(map.description).toContain('Use createRng(seed)');
    expect(map.metadata?.contextNotes).toHaveLength(1);
    expect(map.metadata?.contextNotes?.[0]).toMatchObject({ fromTaskId: '001-prng', note: 'Use createRng(seed) from src/core/prng.ts' });
    // A note is not a proposal
    expect((await readQueueProposals(project)).proposals).toEqual([]);

    // The same merge reported twice adds the note once
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);
    expect(map.metadata?.contextNotes).toHaveLength(1);

    const undo = await undoContextNote('p1', '002-map', map.metadata!.contextNotes![0].id, deps);
    expect(undo.success).toBe(true);
    expect(map.description).toBe('Description of 002-map');
    expect(map.metadata?.contextNotes).toEqual([]);
  });

  it('never touches tasks that started while the model was thinking', async () => {
    modelAnswer = {
      updates: [
        { taskId: '004-loot', kind: 'note', note: 'Late note', reason: 'x' },
        { taskId: '002-map', kind: 'obsolete', reason: 'covered' },
      ],
      newTasks: [],
    };
    const deps = makeDeps();
    const original = deps.runModel;
    deps.runModel = async (input) => {
      const answer = await original(input);
      tasks.find((t) => t.id === '004-loot')!.status = 'in_progress';
      tasks.find((t) => t.id === '002-map')!.status = 'in_progress';
      return answer;
    };
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);
    expect(tasks.find((t) => t.id === '004-loot')!.description).toBe('Description of 004-loot');
    expect((await readQueueProposals(project)).proposals).toEqual([]);
  });

  describe('running dependents', () => {
    let sent: Array<{ taskId: string; text: string }>;
    const withMessaging = (enabled = true): GroomingDeps => {
      const deps = makeDeps();
      deps.messagingEnabled = () => enabled;
      deps.messageTask = async (_projectId, task, text) => {
        sent.push({ taskId: task.id, text });
      };
      return deps;
    };

    beforeEach(() => {
      sent = [];
      // The queue started 002 the moment 001 merged
      tasks.find((t) => t.id === '002-map')!.status = 'in_progress';
    });

    it('sends the note to a running dependent as a message and leaves its description alone', async () => {
      modelAnswer = { updates: [{ taskId: '002-map', kind: 'note', note: 'Use createRng(seed)', reason: 'merged' }], newTasks: [] };
      await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, withMessaging());

      expect(modelCalls[0].prompt).toContain('<ticket id="002-map" column="In progress"');
      // Running tickets that do not depend on the merged task are still left out
      expect(modelCalls[0].prompt).not.toContain('<ticket id="005-ui"');
      expect(sent).toHaveLength(1);
      expect(sent[0].taskId).toBe('002-map');
      expect(sent[0].text).toContain('Use createRng(seed)');
      expect(sent[0].text).toContain('001-prng');
      const map = tasks.find((t) => t.id === '002-map')!;
      expect(map.description).toBe('Description of 002-map');
      expect(map.metadata?.contextNotes).toBeUndefined();
    });

    it('never archives or flags a running dependent, only notes it', async () => {
      modelAnswer = { updates: [{ taskId: '002-map', kind: 'obsolete', reason: 'covered' }], newTasks: [] };
      await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: true }, withMessaging());
      expect(sent).toEqual([]);
      expect(tasks.find((t) => t.id === '002-map')!.metadata?.archivedAt).toBeUndefined();
      expect((await readQueueProposals(project)).proposals).toEqual([]);
    });

    it('skips running dependents when task messaging is off', async () => {
      modelAnswer = { updates: [{ taskId: '002-map', kind: 'note', note: 'x', reason: 'y' }], newTasks: [] };
      await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, withMessaging(false));
      expect(modelCalls[0].prompt).not.toContain('<ticket id="002-map"');
      expect(sent).toEqual([]);
    });

    it('still notes queued tickets by description while running ones get a message', async () => {
      tasks.find((t) => t.id === '004-loot')!.metadata = { dependsOnTaskIds: ['001-prng'] };
      modelAnswer = {
        updates: [
          { taskId: '002-map', kind: 'note', note: 'For the running one', reason: 'y' },
          { taskId: '004-loot', kind: 'note', note: 'For the queued one', reason: 'y' },
        ],
        newTasks: [],
      };
      await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, withMessaging());
      expect(sent.map((m) => m.taskId)).toEqual(['002-map']);
      expect(tasks.find((t) => t.id === '004-loot')!.description).toContain('For the queued one');
    });

    it('logs and carries on when the message cannot be delivered', async () => {
      tasks.find((t) => t.id === '004-loot')!.metadata = { dependsOnTaskIds: ['001-prng'] };
      modelAnswer = {
        updates: [
          { taskId: '002-map', kind: 'note', note: 'A', reason: 'y' },
          { taskId: '004-loot', kind: 'note', note: 'B', reason: 'y' },
        ],
        newTasks: [],
      };
      const deps = withMessaging();
      deps.messageTask = async () => {
        throw new Error('not sent');
      };
      await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);
      expect(tasks.find((t) => t.id === '004-loot')!.description).toContain('B');
    });
  });

  it('stores obsolete, duplicate and new task proposals without applying them', async () => {
    modelAnswer = {
      updates: [
        { taskId: '004-loot', kind: 'obsolete', reason: 'Loot tables exist in src/core/loot.ts' },
        { taskId: '003-mobs', kind: 'duplicate', duplicateOf: '002-map', reason: 'Same outcome' },
      ],
      newTasks: [{ title: 'Add retries to the loader', description: 'Do it', dependsOn: ['002-map'], reason: 'Left open by review' }],
    };
    const deps = makeDeps();
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);

    const proposals = await listQueueProposals('p1', deps);
    expect(proposals.map((p) => p.kind).sort()).toEqual(['duplicate', 'newTask', 'obsolete']);
    expect(tasks.every((t) => !t.metadata?.archivedAt)).toBe(true);
    expect(created).toEqual([]);
    expect(existsSync(getQueueProposalsPath(project))).toBe(true);
    expect(deps.changed).toHaveBeenCalledWith('p1');

    // The same merge reported twice stores each proposal once
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);
    expect(await listQueueProposals('p1', deps)).toHaveLength(3);
  });

  it('survives a model failure without throwing', async () => {
    const deps = makeDeps();
    deps.runModel = async () => {
      throw new Error('model offline');
    };
    await expect(groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps)).resolves.toBeUndefined();
    expect(await listQueueProposals('p1', deps)).toEqual([]);
  });
});

describe('applying and dismissing proposals', () => {
  async function propose(answer: unknown, deps = makeDeps()) {
    modelAnswer = answer;
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: false }, deps);
    return { deps, proposals: await listQueueProposals('p1', deps) };
  }

  it('obsolete: archives the ticket and removes it from the others\' dependencies', async () => {
    const { deps, proposals } = await propose({ updates: [{ taskId: '002-map', kind: 'obsolete', reason: 'covered' }], newTasks: [] });
    const result = await applyQueueProposal('p1', proposals[0].id, deps);
    expect(result.success).toBe(true);
    expect(tasks.find((t) => t.id === '002-map')!.metadata?.archivedAt).toBeTruthy();
    expect(tasks.find((t) => t.id === '003-mobs')!.metadata?.dependsOnTaskIds).toEqual([]);
    expect(await listQueueProposals('p1', deps)).toEqual([]);
  });

  it('duplicate: moves dependents onto the kept ticket, then archives the duplicate', async () => {
    const { deps, proposals } = await propose({ updates: [{ taskId: '002-map', kind: 'duplicate', duplicateOf: '004-loot', reason: 'same' }], newTasks: [] });
    await applyQueueProposal('p1', proposals[0].id, deps);
    expect(tasks.find((t) => t.id === '002-map')!.metadata?.archivedAt).toBeTruthy();
    expect(tasks.find((t) => t.id === '003-mobs')!.metadata?.dependsOnTaskIds).toEqual(['004-loot']);
    expect(tasks.find((t) => t.id === '004-loot')!.metadata?.archivedAt).toBeUndefined();
  });

  it('new task: creates a card in Planning through the normal create path, with its dependencies', async () => {
    const { deps, proposals } = await propose({
      updates: [],
      newTasks: [{ title: 'Add retries to the loader', description: 'Do it', dependsOn: ['002-map'], reason: 'follow-up' }],
    });
    const result = await applyQueueProposal('p1', proposals[0].id, deps);
    expect(result.success).toBe(true);
    expect(created).toEqual([
      { title: 'Add retries to the loader', description: 'Do it', metadata: { sourceType: 'manual', dependsOnTaskIds: ['002-map'] } },
    ]);
    expect(tasks.at(-1)!.status).toBe('backlog');
  });

  it('refuses a proposal whose ticket started running since, and drops it from the list', async () => {
    const { deps, proposals } = await propose({ updates: [{ taskId: '004-loot', kind: 'obsolete', reason: 'covered' }], newTasks: [] });
    tasks.find((t) => t.id === '004-loot')!.status = 'in_progress';
    const result = await applyQueueProposal('p1', proposals[0].id, deps);
    expect(result.success).toBe(false);
    expect(tasks.find((t) => t.id === '004-loot')!.metadata?.archivedAt).toBeUndefined();
    expect(await listQueueProposals('p1', deps)).toEqual([]);
  });

  it('dismiss removes the proposal and changes nothing else', async () => {
    const { deps, proposals } = await propose({ updates: [{ taskId: '004-loot', kind: 'obsolete', reason: 'covered' }], newTasks: [] });
    expect((await dismissQueueProposal('p1', proposals[0].id, deps)).success).toBe(true);
    expect(await listQueueProposals('p1', deps)).toEqual([]);
    expect(tasks.every((t) => !t.metadata?.archivedAt)).toBe(true);
  });
});

describe('autonomous mode (autoApplyStructural)', () => {
  it('applies structural changes at once, each with an undo entry that restores the queue', async () => {
    modelAnswer = {
      updates: [{ taskId: '002-map', kind: 'obsolete', reason: 'covered' }],
      newTasks: [{ title: 'Follow-up card', description: 'Do it', dependsOn: [], reason: 'open finding' }],
    };
    const deps = makeDeps();
    await groomQueueAfterMerge('p1', '001-prng', { autoApplyStructural: true }, deps);

    expect(await listQueueProposals('p1', deps)).toEqual([]);
    expect(tasks.find((t) => t.id === '002-map')!.metadata?.archivedAt).toBeTruthy();
    expect(tasks.find((t) => t.id === '003-mobs')!.metadata?.dependsOnTaskIds).toEqual([]);
    expect(created).toHaveLength(1);

    const { undo } = await readQueueProposals(project);
    expect(undo).toHaveLength(2);
    const obsoleteUndo = undo.find((u) => u.proposal.kind === 'obsolete')!;
    expect(obsoleteUndo.previousDependsOn).toEqual({ '003-mobs': ['002-map'] });

    expect((await undoQueueChange('p1', obsoleteUndo.id, deps)).success).toBe(true);
    expect(tasks.find((t) => t.id === '002-map')!.metadata?.archivedAt).toBeUndefined();
    expect(tasks.find((t) => t.id === '003-mobs')!.metadata?.dependsOnTaskIds).toEqual(['002-map']);

    const newTaskUndo = undo.find((u) => u.proposal.kind === 'newTask')!;
    await undoQueueChange('p1', newTaskUndo.id, deps);
    expect(tasks.at(-1)!.metadata?.archivedAt).toBeTruthy();
    expect((await readQueueProposals(project)).undo).toEqual([]);
  });
});

describe('buildGroomingPrompt', () => {
  it('names the open review findings of the merged task', () => {
    const merged = makeTask('001-prng', 'done', {
      claudeRun: {
        validation: { status: 'passed', summary: 'All good', checks: [], findings: [{ severity: 'minor', description: 'Rename helper', fixed: false, file: 'a.ts' }] },
      } as unknown as Task['claudeRun'],
    });
    const prompt = buildGroomingPrompt(merged, ['src/core/prng.ts'], [makeTask('002-map', 'queue')]);
    expect(prompt).toContain('OPEN minor: Rename helper (a.ts)');
    expect(prompt).toContain('Files changed: src/core/prng.ts');
  });
});
