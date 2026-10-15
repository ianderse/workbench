/**
 * The Claude chat's task tools, over the MCP server the chat session talks to (real HTTP
 * requests; the task IPC handlers and the project store are mocked):
 * - each chat turn has its own token; other requests are refused
 * - tools go through the UI's IPC handlers and the board's move rules
 * - the board reloads after tools that change tasks
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Task, TaskStatus } from '../../../shared/types';
import { IPC_CHANNELS } from '../../../shared/constants';

let tasks: Task[] = [];
const invokeIpcHandler = vi.fn();

vi.mock('../../ipc-handlers/ipc-registry', () => ({
  invokeIpcHandler: (...args: unknown[]) => invokeIpcHandler(...args),
}));
vi.mock('../../project-store', () => ({
  projectStore: {
    getProject: (id: string) => (id === 'p1' ? { id: 'p1', path: '/project', settings: { mainBranch: 'develop', maxParallelTasks: 1 } } : undefined),
    getTasks: () => tasks,
    invalidateTasksCache: vi.fn(),
  },
}));
vi.mock('../../settings-utils', () => ({
  readSettingsFile: () => ({ mcpConnectors: { context7: true } }),
}));

import { openTaskToolsSession, closeTaskToolsServer, type TaskToolsSession } from '../task-tools-server';

function task(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
  return {
    id, specId: id, projectId: 'p1', title: `Task ${id}`, description: `Do ${id}`, status,
    subtasks: [], logs: [], createdAt: new Date('2026-10-11'), updatedAt: new Date('2026-10-11'), ...extra,
  };
}

let nextId = 1;
async function rpc(session: TaskToolsSession, method: string, params?: Record<string, unknown>, headers = session.mcpServer.headers) {
  const response = await fetch(session.mcpServer.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

async function call(session: TaskToolsSession, name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc(session, 'tools/call', { name, arguments: args });
  const text = body.result.content[0].text as string;
  return { isError: body.result.isError === true, text, data: body.result.isError ? undefined : JSON.parse(text) };
}

const onTasksChanged = vi.fn();
const open = () => openTaskToolsSession({ projectId: 'p1', onTasksChanged });

beforeEach(() => {
  vi.clearAllMocks();
  tasks = [task('001-a', 'backlog'), task('002-b', 'human_review'), task('003-c', 'done', { metadata: { archivedAt: '2026-10-10' } })];
  invokeIpcHandler.mockResolvedValue({ success: true });
});

afterAll(async () => {
  await closeTaskToolsServer();
});

describe('task tools server', () => {
  it('speaks MCP to its own chat turn only', async () => {
    const session = await open();
    const init = await rpc(session, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'workbench' } });

    const notification = await fetch(session.mcpServer.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...session.mcpServer.headers },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(notification.status).toBe(202);

    const list = await rpc(session, 'tools/list');
    const names = list.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_tasks', 'get_task', 'get_task_logs', 'create_task', 'update_task', 'start_task', 'stop_task', 'move_task',
      'retry_task', 'request_changes', 'create_pull_request', 'merge_pull_request', 'archive_tasks', 'unarchive_tasks', 'delete_task',
    ]));

    expect((await rpc(session, 'tools/list', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
    session.close();
    expect((await rpc(session, 'tools/list')).status).toBe(401);
  });

  it('lists the tasks on the board, leaving archived ones out unless asked', async () => {
    const session = await open();
    const { data } = await call(session, 'list_tasks');
    expect(data.map((t: { id: string }) => t.id)).toEqual(['001-a', '002-b']);
    expect(data[1]).toMatchObject({ status: 'human_review', column: 'Human Review' });
    expect((await call(session, 'list_tasks', { includeArchived: true, status: ['done'] })).data).toHaveLength(1);
    expect(onTasksChanged).not.toHaveBeenCalled();
    session.close();
  });

  it('creates a task like the new task dialog does and starts it', async () => {
    const session = await open();
    invokeIpcHandler.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === IPC_CHANNELS.TASK_CREATE) {
        tasks.push(task('004-new', 'backlog', { title: 'New one' }));
        expect(args).toEqual(['p1', 'New one', 'Add a health check endpoint', { sourceType: 'manual', mcpConnectors: ['context7'], baseBranch: 'develop' }]);
        return { success: true, data: tasks.at(-1) };
      }
      return { success: true };
    });
    const { data } = await call(session, 'create_task', { title: 'New one', description: 'Add a health check endpoint', start: true });
    expect(data).toMatchObject({ id: '004-new', action: 'started' });
    expect(invokeIpcHandler).toHaveBeenCalledWith(IPC_CHANNELS.TASK_START, '004-new');
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('queues a started task when the parallel limit is reached', async () => {
    tasks.push(task('005-running', 'in_progress'));
    const session = await open();
    const { data } = await call(session, 'start_task', { taskId: '001-a' });
    expect(data).toEqual({ id: '001-a', action: 'queued' });
    expect(invokeIpcHandler).toHaveBeenCalledWith(IPC_CHANNELS.TASK_UPDATE_STATUS, '001-a', 'queue');
    expect(invokeIpcHandler).not.toHaveBeenCalledWith(IPC_CHANNELS.TASK_START, '001-a');
    session.close();
  });

  it("keeps to the board's move rules", async () => {
    const session = await open();
    const refused = await call(session, 'move_task', { taskId: '001-a', to: 'done' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("A task in Planning can't be moved to Done (allowed: Queue, In Progress)");
    expect(invokeIpcHandler).not.toHaveBeenCalled();

    await call(session, 'move_task', { taskId: '002-b', to: 'backlog' });
    expect(invokeIpcHandler).toHaveBeenCalledWith(IPC_CHANNELS.TASK_UPDATE_STATUS, '002-b', 'backlog', undefined);
    session.close();
  });

  it('asks what to do with the worktree when moving a task to Done', async () => {
    const session = await open();
    invokeIpcHandler.mockResolvedValueOnce({ success: false, worktreeExists: true, error: 'A worktree still exists' });
    const asked = await call(session, 'move_task', { taskId: '002-b', to: 'done' });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain('keep it or delete it');

    await call(session, 'move_task', { taskId: '002-b', to: 'done', worktree: 'keep' });
    expect(invokeIpcHandler).toHaveBeenLastCalledWith(IPC_CHANNELS.TASK_UPDATE_STATUS, '002-b', 'done', { keepWorktree: true });
    session.close();
  });

  it('reports what the IPC handler refused, and reloads the board anyway', async () => {
    const session = await open();
    invokeIpcHandler.mockResolvedValueOnce({ success: false, error: 'Cannot delete a running task. Stop the task first.' });
    const result = await call(session, 'delete_task', { taskId: '001-a' });
    expect(result).toMatchObject({ isError: true, text: 'Cannot delete a running task. Stop the task first.' });
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
    expect((await call(session, 'get_task', { taskId: '999-missing' })).text).toContain('No task "999-missing"');
    session.close();
  });

  it('requests changes and merges pull requests through the same handlers as the UI', async () => {
    const session = await open();
    await call(session, 'request_changes', { taskId: '002-b', feedback: 'Rename the endpoint' });
    expect(invokeIpcHandler).toHaveBeenCalledWith(IPC_CHANNELS.TASK_REVIEW, '002-b', false, 'Rename the endpoint');

    invokeIpcHandler.mockResolvedValueOnce({ success: true, data: { success: true, targetBranch: 'develop', conflictedFiles: [] } });
    const merged = await call(session, 'merge_pull_request', { taskId: '002-b' });
    expect(merged.data).toMatchObject({ id: '002-b', success: true, targetBranch: 'develop' });
    expect(invokeIpcHandler).toHaveBeenLastCalledWith(IPC_CHANNELS.TASK_WORKTREE_MERGE_PR, '002-b', { targetBranch: undefined });
    session.close();
  });
});
