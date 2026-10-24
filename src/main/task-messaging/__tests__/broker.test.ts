import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';
import { leadSessionName, taskSessionName } from '../../../shared/utils/task-messaging';
import {
  configureTaskMessaging,
  deliver,
  formatInboxSection,
  formatMessage,
  markInboxRead,
  noteNativeSend,
  notePeerMessage,
  registerLeadTarget,
  registerLiveRun,
  resetTaskMessagingForTests,
  takeInbox,
  taskSpecDir,
} from '../broker';
import { readInbox, TASK_INBOX_FILE } from '../inbox';
import type { TaskMessage } from '../types';

let root: string;
let project: Project;
let tasks: Task[];

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `Title ${specId}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() };
}

const me = { kind: 'task' as const, specId: '001-me', title: 'Me', sessionName: 'wb-x-001-me' };

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'broker-'));
  project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
  tasks = [
    task('001-me', 'in_progress'),
    task('002-live', 'in_progress'),
    task('003-queued', 'queue'),
    task('004-review', 'human_review'),
    task('005-done', 'done', { prState: 'merged' }),
    task('006-archived', 'human_review', { archivedAt: '2026-10-01T00:00:00Z' }),
  ];
  configureTaskMessaging({ getProject: (id) => (id === 'p1' ? project : undefined), getTasks: () => tasks });
});

afterEach(() => {
  resetTaskMessagingForTests();
  rmSync(root, { recursive: true, force: true });
});

describe('deliver', () => {
  it('writes to a live run and marks the message read once the session read it', async () => {
    const send = vi.fn((_text: string, id: string) => id);
    registerLiveRun({ projectId: 'p1', specId: '002-live', sessionName: 'wb-002', send });

    const outcome = await deliver('p1', '002', me, 'I am changing foo()');
    expect(outcome.status).toBe('delivered');
    expect(outcome.detail).toMatch(/^delivered: /);
    expect(send.mock.calls[0][0]).toBe('[Message from task 001-me "Me" (session wb-x-001-me)]\nI am changing foo()');
    const specDir = taskSpecDir(project, '002-live');
    expect((await readInbox(specDir))[0]).toMatchObject({ id: outcome.messageId, status: 'sent' });

    await markInboxRead('p1', '002-live', [outcome.messageId!]);
    expect((await readInbox(specDir))[0].status).toBe('read');
  });

  it('queues for tasks that are not running, and says when they will read it', async () => {
    const queued = await deliver('p1', '003-queued', me, 'hello');
    expect(queued).toMatchObject({ status: 'queued' });
    expect(queued.detail).toContain('it has not started yet');
    const review = await deliver('p1', taskSessionName('p1', '004-review'), me, 'hello');
    expect(review.detail).toContain('it is not running (Human Review)');
    const between = await deliver('p1', '002-live', me, 'hi');
    expect(between.detail).toContain('between steps');

    const file = path.join(taskSpecDir(project, '003-queued'), TASK_INBOX_FILE);
    expect(JSON.parse(readFileSync(file, 'utf-8')).messages).toHaveLength(1);
    expect((await takeInbox('p1', '003-queued')).map((m) => m.text)).toEqual(['hello']);
  });

  it('falls back to the inbox when the live run no longer takes messages', async () => {
    registerLiveRun({ projectId: 'p1', specId: '002-live', sessionName: 'wb-002', send: () => false });
    const outcome = await deliver('p1', '002-live', me, 'hi');
    expect(outcome.status).toBe('queued');
    expect((await takeInbox('p1', '002-live')).map((m) => m.status)).toEqual(['queued']);
  });

  it('refuses done, archived, unknown, own and oversized targets', async () => {
    expect((await deliver('p1', '005-done', me, 'x')).detail).toMatch(/^not sent: 005-done is done \(merged\)/);
    expect((await deliver('p1', '006', me, 'x')).detail).toMatch(/^not sent: 006-archived is archived/);
    expect((await deliver('p1', '099', me, 'x')).detail).toMatch(/^not sent: no task "099"/);
    expect((await deliver('p1', '001-me', me, 'x')).detail).toBe('not sent: that is your own task');
    expect((await deliver('p1', '002', me, 'x'.repeat(9000))).status).toBe('refused');
    expect((await deliver('p1', '002', me, '   ')).status).toBe('refused');
    // Another project's session name is not one of ours
    expect((await deliver('p1', taskSessionName('p2', '002-live'), me, 'x')).status).toBe('refused');
  });

  it('sends "lead" messages to the registered lead target, and refuses without one', async () => {
    expect((await deliver('p1', 'lead', me, 'x')).detail).toBe('not sent: no project lead session');
    const handler = vi.fn(async (_projectId: string, _message: TaskMessage) => ({ status: 'delivered' as const, detail: 'delivered: the lead reads it' }));
    const off = registerLeadTarget(handler);
    expect((await deliver('p1', leadSessionName('p1'), me, 'hi lead')).detail).toBe('delivered: the lead reads it');
    expect(handler.mock.calls[0][1]).toMatchObject({ text: 'hi lead', from: me });
    off();
    expect((await deliver('p1', 'lead', me, 'x')).status).toBe('refused');
  });
});

describe('live runs ending', () => {
  it('moves messages the process never read back to the inbox', async () => {
    const end = registerLiveRun({ projectId: 'p1', specId: '002-live', sessionName: 'wb-002', send: (_t, id) => id });
    const read = await deliver('p1', '002-live', me, 'read one');
    const unread = await deliver('p1', '002-live', me, 'unread one');
    await markInboxRead('p1', '002-live', [read.messageId!]);
    await end([unread.messageId!]);

    const pending = await takeInbox('p1', '002-live');
    expect(pending.map((m) => [m.text, m.status])).toEqual([['unread one', 'queued']]);
  });

  it('treats messages still marked sent as unread once the task is not live (a crash)', async () => {
    registerLiveRun({ projectId: 'p1', specId: '002-live', sessionName: 'wb-002', send: (_t, id) => id });
    await deliver('p1', '002-live', me, 'in flight');
    expect(await takeInbox('p1', '002-live')).toEqual([]);
    resetTaskMessagingForTests();
    configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
    expect((await takeInbox('p1', '002-live')).map((m) => m.text)).toEqual(['in flight']);
  });
});

describe('native SendMessage', () => {
  const to = () => taskSessionName('p1', '002-live');

  it('delivers a failed send through the broker and tells the sender', async () => {
    const outcome = await noteNativeSend({ projectId: 'p1', from: me, to: to(), text: 'hi', toolResult: { success: false, message: 'No agent named' }, isError: false });
    expect(outcome?.status).toBe('queued');
    expect((await takeInbox('p1', '002-live')).map((m) => m.text)).toEqual(['hi']);
    const notice = (await takeInbox('p1', '001-me'))[0];
    expect(notice.from.kind).toBe('workbench');
    expect(notice.text).toContain('did not reach it');
  });

  it('requeues a successful send the receiver never showed in its stream', async () => {
    const end = registerLiveRun({ projectId: 'p1', specId: '002-live', sessionName: to(), send: (_t, id) => id });
    await noteNativeSend({ projectId: 'p1', from: me, to: to(), text: 'lost', toolResult: { success: true, msg_id: 'm1' }, isError: false });
    await noteNativeSend({ projectId: 'p1', from: me, to: to(), text: 'seen', toolResult: { success: true, msg_id: 'm2' }, isError: false });
    notePeerMessage('p1', '002-live', 'm2');
    await end([]);
    expect((await takeInbox('p1', '002-live')).map((m) => m.text)).toEqual(['lost']);
  });

  it('ignores names that are not tasks of this project', async () => {
    expect(await noteNativeSend({ projectId: 'p1', from: me, to: 'helper-agent', text: 'x', toolResult: { success: false }, isError: false })).toBeUndefined();
    expect(await noteNativeSend({ projectId: 'p1', from: me, to: taskSessionName('p2', '002-live'), text: 'x', toolResult: { success: false }, isError: false })).toBeUndefined();
    expect(await takeInbox('p1', '002-live')).toEqual([]);
  });
});

describe('formatting', () => {
  it('labels messages by sender and frames the inbox section', () => {
    expect(formatMessage({ from: { kind: 'workbench' }, text: 'Task 002 started.' })).toBe('[Workbench] Task 002 started.');
    expect(formatMessage({ from: { kind: 'lead' }, text: 'Hold off.' })).toBe('[Project lead] Hold off.');
    const section = formatInboxSection([{ id: 'wbm-1', at: '', status: 'queued', from: { kind: 'workbench' }, text: 'x' }]);
    expect(section).toContain('Messages from parallel tasks and Workbench received while you were not running');
    expect(section).toContain('[Workbench] x');
    expect(formatInboxSection([])).toBe('');
  });
});
