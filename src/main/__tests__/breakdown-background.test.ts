/**
 * Break into tasks: the prompt is stored as a proposal when a run starts and replaced by the result
 * (or failure) in queue-proposals.json, listed with the other queue updates
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../shared/types';

const handlers = new Map<string, (...args: never[]) => unknown>();
const added: unknown[] = [];
const dismissed: string[] = [];
let breakdownImpl: () => Promise<unknown>;

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../project-store', () => ({
  projectStore: { getProject: () => ({ id: 'p1', path: '/p' }), getTasks: () => [] },
}));
vi.mock('../ipc-handlers/ipc-registry', () => ({
  handleIpc: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
  onIpc: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
}));
vi.mock('../task-breakdown', () => ({ breakDownTask: () => breakdownImpl() }));
vi.mock('../spec-batches', () => ({ newSpecBatchId: () => 'batch-1', specSourcesOf: () => ['docs/A.md'] }));
vi.mock('../queue-grooming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../queue-grooming')>();
  return { ...actual, addBreakdownProposal: async (_p: string, proposal: unknown) => { added.push(proposal); return { success: true }; },
    dismissQueueProposal: async (_p: string, id: string) => { dismissed.push(id); return { success: true }; },
  };
});

import { IPC_CHANNELS } from '../../shared/constants';
import { registerTaskBreakdownHandlers } from '../ipc-handlers/task/breakdown-handlers';
import type { GroomingDeps } from '../queue-grooming';
const {
  addBreakdownProposal: realAdd,
  applyQueueProposal,
  failInterruptedBreakdowns,
  dismissQueueProposal,
  listQueueProposals,
} = await vi.importActual<typeof import('../queue-grooming')>('../queue-grooming');
import { isBreakdownProposal } from '../../shared/types/queue-grooming';

const event = { sender: { isDestroyed: () => false, send: vi.fn() } };
const run = (requestId: string) =>
  (handlers.get(IPC_CHANNELS.TASK_BREAKDOWN) as unknown as (...a: unknown[]) => Promise<{ success: boolean; data?: { tasks: unknown[]; batchId?: string }; error?: string }>)(
    event, 'p1', requestId, 'Build from docs/A.md', ['a.png']
  );
const save = (...args: unknown[]) => (handlers.get(IPC_CHANNELS.TASK_BREAKDOWN_SAVE) as unknown as (...a: unknown[]) => Promise<{ success: boolean }>)({}, ...args);

beforeEach(() => {
  handlers.clear();
  added.length = 0;
  dismissed.length = 0;
  registerTaskBreakdownHandlers();
});

describe('breakdown handler', () => {
  const oneTask = { tasks: [{ key: 't1', title: 'One', description: 'd', dependsOn: [] }] };

  it('stores the prompt when a run starts, then the result under the same id, and returns that id', async () => {
    let finish!: (value: unknown) => void;
    breakdownImpl = () => new Promise((resolve) => { finish = resolve; });
    const pending = run('r1');
    await vi.waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toMatchObject({ kind: 'breakdownRunning', prompt: 'Build from docs/A.md', attachmentNames: ['a.png'] });
    finish(oneTask);
    const result = await pending;
    expect(result.success).toBe(true);
    expect(added).toHaveLength(2);
    const runningId = (added[0] as { id: string }).id;
    expect(result.data).toMatchObject({ proposalId: runningId });
    expect(added[1]).toMatchObject({
      id: runningId,
      kind: 'breakdown',
      prompt: 'Build from docs/A.md',
      attachmentNames: ['a.png'],
      breakdown: { batchId: 'batch-1', specSources: ['docs/A.md'], tasks: [{ key: 't1' }] },
    });
    expect((added[1] as { breakdown: object }).breakdown).not.toHaveProperty('proposalId');
  });

  it('stores a failure with the prompt, and removes the entry of a cancelled run', async () => {
    breakdownImpl = async () => { throw new Error('The model returned no tasks'); };
    expect((await run('r3')).success).toBe(false);
    expect(added).toEqual([
      expect.objectContaining({ kind: 'breakdownRunning' }),
      expect.objectContaining({ kind: 'breakdownFailed', prompt: 'Build from docs/A.md', error: 'The model returned no tasks' }),
    ]);

    added.length = 0;
    let fail!: (error: Error) => void;
    breakdownImpl = () => new Promise((_, reject) => { fail = reject; });
    const second = run('r4');
    await vi.waitFor(() => expect(added).toHaveLength(1));
    (handlers.get(IPC_CHANNELS.TASK_BREAKDOWN_CANCEL) as unknown as (...a: unknown[]) => void)({}, 'r4');
    const aborted = new Error('x');
    aborted.name = 'AbortError';
    fail(aborted);
    expect((await second).error).toBe('cancelled');
    expect(added).toHaveLength(1);
    expect(dismissed).toEqual([(added[0] as { id: string }).id]);
  });

  it('save-for-later replaces the stored result with the edited one', async () => {
    expect((await save('p1', 'Prompt', [], oneTask, 'existing-id')).success).toBe(true);
    expect(added).toEqual([expect.objectContaining({ id: 'existing-id', kind: 'breakdown', breakdown: oneTask })]);
  });
});

describe('breakdown proposals in the queue proposals store', () => {
  let tmp: string;
  let deps: GroomingDeps;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'breakdown-proposals-'));
    const project = { id: 'p1', name: 'P', path: tmp, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
    deps = { getProject: () => project, getTasks: () => [], changed: vi.fn() } as unknown as GroomingDeps;
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('lists a stored proposal, cannot be applied from the panel, and is dismissed', async () => {
    const breakdown = { tasks: [{ key: 't1', title: 'One', description: 'd', dependsOn: [] }] };
    await realAdd('p1', { id: 'b1', kind: 'breakdown', createdAt: 'now', prompt: 'Prompt', attachmentNames: [], breakdown }, deps);
    await realAdd('p1', { id: 'b2', kind: 'breakdownFailed', createdAt: 'now', prompt: 'Prompt', error: 'boom' }, deps);

    const listed = await listQueueProposals('p1', deps);
    expect(listed.map((p) => p.kind)).toEqual(['breakdown', 'breakdownFailed']);
    expect(listed.every(isBreakdownProposal)).toBe(true);
    expect((listed[0] as { breakdown: unknown }).breakdown).toEqual(breakdown);
    expect(deps.changed).toHaveBeenCalledWith('p1');

    expect((await applyQueueProposal('p1', 'b1', deps)).success).toBe(false);
    expect(await listQueueProposals('p1', deps)).toHaveLength(2);

    await dismissQueueProposal('p1', 'b1', deps);
    await dismissQueueProposal('p1', 'b2', deps);
    expect(await listQueueProposals('p1', deps)).toHaveLength(0);
  });

  it('replaces a running entry by its result in place, and keeps the prompt', async () => {
    const breakdown = { tasks: [{ key: 't1', title: 'One', description: 'd', dependsOn: [] }] };
    await realAdd('p1', { id: 'a', kind: 'breakdownRunning', createdAt: 'now', prompt: 'Prompt', attachmentNames: ['x.png'] }, deps);
    await realAdd('p1', { id: 'b', kind: 'breakdownRunning', createdAt: 'now', prompt: 'Other', attachmentNames: [] }, deps);
    await realAdd('p1', { id: 'a', kind: 'breakdown', createdAt: 'now', prompt: 'Prompt', attachmentNames: ['x.png'], breakdown }, deps);
    const listed = await listQueueProposals('p1', deps);
    expect(listed.map((p) => [p.id, p.kind])).toEqual([['a', 'breakdown'], ['b', 'breakdownRunning']]);
  });

  it('turns a leftover running entry into a failure on startup, with the prompt', async () => {
    await realAdd('p1', { id: 'a', kind: 'breakdownRunning', createdAt: 'now', prompt: 'Long prompt', attachmentNames: [] }, deps);
    await failInterruptedBreakdowns('p1', deps);
    expect(await listQueueProposals('p1', deps)).toEqual([
      { id: 'a', kind: 'breakdownFailed', createdAt: 'now', prompt: 'Long prompt', error: 'Interrupted by a restart' },
    ]);
  });

  it('removes a stored result when it is dismissed (tickets created or discarded in the dialog)', async () => {
    const breakdown = { tasks: [{ key: 't1', title: 'One', description: 'd', dependsOn: [] }] };
    await realAdd('p1', { id: 'a', kind: 'breakdown', createdAt: 'now', prompt: 'P', attachmentNames: [], breakdown }, deps);
    await dismissQueueProposal('p1', 'a', deps);
    await dismissQueueProposal('p1', 'a', deps);
    expect(await listQueueProposals('p1', deps)).toEqual([]);
  });
});
