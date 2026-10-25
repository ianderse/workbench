/**
 * Break into tasks left running in the background: the result (or failure) is stored as a
 * proposal in queue-proposals.json and listed with the other queue updates
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../../shared/types';

const handlers = new Map<string, (...args: never[]) => unknown>();
const added: unknown[] = [];
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
  return { ...actual, addBreakdownProposal: async (_p: string, proposal: unknown) => { added.push(proposal); return { success: true }; } };
});

import { IPC_CHANNELS } from '../../shared/constants';
import { registerTaskBreakdownHandlers } from '../ipc-handlers/task/breakdown-handlers';
import type { GroomingDeps } from '../queue-grooming';
const {
  addBreakdownProposal: realAdd,
  applyQueueProposal,
  dismissQueueProposal,
  listQueueProposals,
} = await vi.importActual<typeof import('../queue-grooming')>('../queue-grooming');
import { isBreakdownProposal } from '../../shared/types/queue-grooming';

const event = { sender: { isDestroyed: () => false, send: vi.fn() } };
const run = (requestId: string) =>
  (handlers.get(IPC_CHANNELS.TASK_BREAKDOWN) as unknown as (...a: unknown[]) => Promise<{ success: boolean; data?: { tasks: unknown[]; batchId?: string }; error?: string }>)(
    event, 'p1', requestId, 'Build from docs/A.md', ['a.png']
  );
const background = (requestId: string) => (handlers.get(IPC_CHANNELS.TASK_BREAKDOWN_BACKGROUND) as unknown as (...a: unknown[]) => void)({}, requestId);

beforeEach(() => {
  handlers.clear();
  added.length = 0;
  registerTaskBreakdownHandlers();
});

describe('breakdown handler', () => {
  it('stores the result as a proposal when the run was left in the background', async () => {
    let finish!: (value: unknown) => void;
    breakdownImpl = () => new Promise((resolve) => { finish = resolve; });
    const pending = run('r1');
    background('r1');
    finish({ tasks: [{ key: 't1', title: 'One', description: 'd', dependsOn: [] }] });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: 'breakdown',
      prompt: 'Build from docs/A.md',
      attachmentNames: ['a.png'],
      breakdown: { batchId: 'batch-1', specSources: ['docs/A.md'], tasks: [{ key: 't1' }] },
    });
  });

  it('stores nothing when the dialog stayed open', async () => {
    breakdownImpl = async () => ({ tasks: [{ key: 't1', title: 'One', description: 'd', dependsOn: [] }] });
    await run('r2');
    expect(added).toHaveLength(0);
  });

  it('stores a failure that happened in the background, and not a cancelled run', async () => {
    let fail!: (error: Error) => void;
    breakdownImpl = () => new Promise((_, reject) => { fail = reject; });
    const pending = run('r3');
    background('r3');
    fail(new Error('The model returned no tasks'));
    expect((await pending).success).toBe(false);
    expect(added).toEqual([expect.objectContaining({ kind: 'breakdownFailed', error: 'The model returned no tasks' })]);

    added.length = 0;
    breakdownImpl = () => new Promise((_, reject) => { fail = reject; });
    const second = run('r4');
    background('r4');
    (handlers.get(IPC_CHANNELS.TASK_BREAKDOWN_CANCEL) as unknown as (...a: unknown[]) => void)({}, 'r4');
    const aborted = new Error('x');
    aborted.name = 'AbortError';
    fail(aborted);
    expect((await second).error).toBe('cancelled');
    expect(added).toHaveLength(0);
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
});
