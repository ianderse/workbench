import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Task, TaskStatus } from '../../../shared/types';
import { taskSessionName } from '../../../shared/utils/task-messaging';
import { configureTaskMessaging, registerLiveRun, resetTaskMessagingForTests, takeInbox } from '../broker';
import { runTaskRunTool } from '../tools';

let root: string;
let tasks: Task[];

function task(specId: string, status: TaskStatus, metadata: Task['metadata'] = {}): Task {
  return { id: specId, specId, projectId: 'p1', title: `Title ${specId}`, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date() };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  const project = { id: 'p1', name: 'P', path: root, autoBuildPath: '.workbench', settings: { mainBranch: 'main' } } as unknown as Project;
  tasks = [task('001-me', 'in_progress'), task('002-other', 'in_progress', { baseBranch: 'develop' }), task('003-done', 'done'), task('004-backlog', 'backlog')];
  configureTaskMessaging({ getProject: () => project, getTasks: () => tasks });
  mkdirSync(path.join(root, '.workbench'), { recursive: true });
  writeFileSync(path.join(root, '.workbench', 'changelog.jsonl'), JSON.stringify({ at: '2026-10-01T00:00:00Z', task: '002-other', event: 'state', status: 'in_progress', files: ['src/a.ts'] }));
});

afterEach(() => {
  resetTaskMessagingForTests();
  rmSync(root, { recursive: true, force: true });
});

const context = { projectId: 'p1', specId: '001-me' };

describe('task run tools', () => {
  it('message_task sends from the calling task and answers in plain words', async () => {
    expect(await runTaskRunTool(context, 'message_task', { task: '002', message: 'heads up' })).toMatch(/^queued: 002-other/);
    const [message] = await takeInbox('p1', '002-other');
    expect(message.from).toEqual({ kind: 'task', specId: '001-me', title: 'Title 001-me', sessionName: taskSessionName('p1', '001-me') });
    expect(await runTaskRunTool(context, 'message_task', { task: '003-done', message: 'x' })).toMatch(/^not sent: 003-done is done/);
    expect(await runTaskRunTool(context, 'message_task', { message: 'x' })).toMatch(/^not sent/);
  });

  it('list_parallel_tasks shows the other unmerged tasks with session, status, files and whether they run', async () => {
    registerLiveRun({ projectId: 'p1', specId: '002-other', sessionName: 'x', send: () => false });
    const listed = await runTaskRunTool(context, 'list_parallel_tasks', {}) as { tasks: Array<Record<string, unknown>> };
    expect(listed.tasks).toEqual([{
      task: '002-other',
      title: 'Title 002-other',
      status: 'In Progress',
      session: taskSessionName('p1', '002-other'),
      runningNow: true,
      baseBranch: 'develop',
      files: ['src/a.ts'],
    }]);
  });

  it('refuses unknown tools', async () => {
    await expect(runTaskRunTool(context, 'create_task', {})).rejects.toThrow('Unknown tool');
  });
});
