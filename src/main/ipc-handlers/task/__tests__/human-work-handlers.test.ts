import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task, IPCResult, TaskMetadata } from '../../../../shared/types';
import type { HumanWorkstream } from '../../../../shared/types/human-work';
import { IPC_CHANNELS, getSpecsDir } from '../../../../shared/constants';
import { invokeIpcHandler } from '../../ipc-registry';
import { registerHumanWorkHandlers, collectHumanReviewActions } from '../human-work-handlers';
import { shell } from 'electron';
const state = vi.hoisted(() => ({ project: undefined as Project | undefined, task: undefined as Task | undefined, file: '', notify: vi.fn(), changed: vi.fn() }));
vi.mock('../../../project-store', () => ({ projectStore: { invalidateTasksCache: vi.fn() } }));
vi.mock('../shared', () => ({ findTaskAndProject: (id: string, projectId: string) => {
  if (state.project?.id !== projectId || state.task?.id !== id) return {};
  return { project: state.project, task: { ...state.task, metadata: JSON.parse(readFileSync(state.file, 'utf8')) } };
} }));
vi.mock('../../../services/task-queue', () => {
  let tail = Promise.resolve<unknown>(undefined);
  return { taskQueue: { runExclusive: (_id: string, fn: () => Promise<unknown>) => { const next = tail.then(fn); tail = next.catch(() => undefined); return next; } } };
});
vi.mock('../../../notification-service', () => ({ notificationService: { notifyContent: state.notify } }));
vi.mock('../../utils', () => ({ safeSendToRenderer: state.changed }));
let root: string;
const finding = { severity: 'blocker' as const, description: 'Human approval is missing.', file: 'docs/report.md', requiresHuman: true };
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wb-human-ipc-'));
  state.project = { id: 'p', path: root, autoBuildPath: '.workbench' } as Project;
  state.task = { id: '001-human', specId: '001-human', projectId: 'p', status: 'human_review', title: 'Human gate', claudeRun: { reviewVerdict: { status: 'failed', rounds: 1, maxRounds: 3, failure: { openFindings: [finding], reason: 'Human input', failingChecks: [], roundLines: [] } } } } as unknown as Task;
  state.file = path.join(root, getSpecsDir(state.project.autoBuildPath), state.task.specId, 'task_metadata.json');
  mkdirSync(path.dirname(state.file), { recursive: true });
  writeFileSync(state.file, JSON.stringify({ userDescription: 'Original request', dependsOnTaskIds: ['other-task'], customField: 'preserved' }));
  state.notify.mockClear(); state.changed.mockClear();
  registerHumanWorkHandlers(() => null);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const call = (mutation: unknown, projectId = 'p') => invokeIpcHandler<IPCResult<HumanWorkstream>>(IPC_CHANNELS.TASK_HUMAN_WORK, projectId, '001-human', mutation);
it('persists through the IPC path without altering source evidence, task state or unrelated metadata', async () => {
  const result = await call({ action: 'create', expectedRevision: 0, finding });
  expect(result.success).toBe(true);
  const metadata = JSON.parse(readFileSync(state.file, 'utf8'));
  expect(metadata).toMatchObject({ customField: 'preserved', dependsOnTaskIds: ['other-task'], humanWork: { revision: 1, items: [{ finding, status: 'open' }] } });
  expect(state.task?.claudeRun?.reviewVerdict?.status).toBe('failed');
  expect(state.notify).toHaveBeenCalledTimes(1);
  await collectHumanReviewActions('p', '001-human');
  expect(JSON.parse(readFileSync(state.file, 'utf8')).humanWork.items).toHaveLength(1);
  expect(state.notify).toHaveBeenCalledTimes(1);
});
it('serializes competing revisions and rejects a foreign project or a changed finding', async () => {
  const writes = await Promise.all([call({ action: 'create', expectedRevision: 0, finding }), call({ action: 'create', expectedRevision: 0, finding })]);
  expect(writes.filter((result) => result.success)).toHaveLength(1);
  expect((await call({ action: 'create', expectedRevision: 1, finding }, 'foreign')).success).toBe(false);
  expect((await call({ action: 'create', expectedRevision: 1, finding: { ...finding, description: 'Invented requirement' } })).success).toBe(false);
  state.task!.status = 'in_progress';
  expect((await call({ action: 'create', expectedRevision: 1, finding })).success).toBe(false);
});
it('rejects incomplete evidence and stale edits without rewriting the durable record', async () => {
  const first = await call({ action: 'create', expectedRevision: 0, finding });
  const before = readFileSync(state.file, 'utf8');
  const result = await call({ action: 'update', expectedRevision: 1, id: first.data!.items[0].id, status: 'submitted', owner: 'Ian', response: '', evidence: '' });
  expect(result.success).toBe(false);
  expect(readFileSync(state.file, 'utf8')).toBe(before);
  const metadata = JSON.parse(before) as TaskMetadata;
  expect(metadata.humanWork?.items[0].history).toEqual([]);
});

it('persists a named override and stops creating repeated human approval actions', async () => {
  const result = await call({ action: 'override', expectedRevision: 0, approver: 'Ian', reason: 'Approve Research and waive renewed human approval for this task.' });
  expect(result.success).toBe(true);
  const metadata = JSON.parse(readFileSync(state.file, 'utf8'));
  expect(metadata).toMatchObject({ customField: 'preserved', humanWork: { approvalOverride: { approver: 'Ian', scope: 'task-human-approval' }, items: [] } });
  await collectHumanReviewActions('p', '001-human');
  expect(JSON.parse(readFileSync(state.file, 'utf8')).humanWork.items).toEqual([]);
  expect(state.task?.claudeRun?.reviewVerdict?.status).toBe('failed');
});

it('opens only available review artifacts for the owning project through IPC', async () => {
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs/report.md'), '[Study protocol](protocol.md)');
  writeFileSync(path.join(root, 'docs/protocol.md'), 'Actual recording sheets');
  const packet = await invokeIpcHandler<IPCResult<import('../../../../shared/types/human-work').HumanReviewPacket>>(IPC_CHANNELS.TASK_HUMAN_REVIEW_PACKET, 'p', '001-human');
  expect(packet.data?.artifacts).toContainEqual(expect.objectContaining({ path: 'docs/protocol.md', available: true }));
  const open = (project: string, ref: string, action = 'open', expectedRoot = packet.data!.root) => invokeIpcHandler<IPCResult>(IPC_CHANNELS.TASK_HUMAN_REVIEW_OPEN, project, '001-human', ref, action, expectedRoot);
  expect((await open('p', 'docs/protocol.md', 'reveal')).success).toBe(true);
  expect(shell.showItemInFolder).toHaveBeenCalledWith(realpathSync(path.join(root, 'docs/protocol.md')));
  expect((await open('p', 'docs/protocol.md')).success).toBe(true);
  expect(shell.openPath).toHaveBeenCalledWith(realpathSync(path.join(root, 'docs/protocol.md')));
  expect((await open('foreign', 'docs/protocol.md')).success).toBe(false);
  expect((await open('p', '../outside.md')).success).toBe(false);
  expect((await open('p', 'docs/unlisted.md')).success).toBe(false);
  expect((await open('p', 'docs/protocol.md', 'execute')).success).toBe(false);
  expect((await open('p', 'docs/protocol.md', 'open', '/a-previous-checkout')).success).toBe(false);
});
