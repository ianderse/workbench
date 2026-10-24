/**
 * @vitest-environment jsdom
 */

/**
 * The task actions that reach a task's Claude Code run have to tell the main process which
 * project's board they come from. A task id is only unique inside its project (two projects can
 * both hold `001-add-login`), and the main process keeps its runs per project and task, so a
 * request that arrives without the project leaves it searching the projects for the id - which
 * finds a project that holds such a task rather than the one running it. These tests check the
 * project goes out with every one of those calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task, TaskStatus } from '../../../shared/types';

const api = {
  getTasks: vi.fn(),
  createTask: vi.fn(),
  startTask: vi.fn(),
  stopTask: vi.fn(),
  retryTask: vi.fn(async () => ({ success: true, data: { action: 'started' as const } })),
  submitReview: vi.fn(async () => ({ success: true })),
  updateTaskStatus: vi.fn(async () => ({ success: true })),
  updateTask: vi.fn(),
  checkTaskRunning: vi.fn(async () => ({ success: true, data: true })),
  recoverStuckTask: vi.fn(),
  deleteTask: vi.fn(async () => ({ success: true })),
  archiveTasks: vi.fn(),
};

vi.stubGlobal('window', { electronAPI: api });

const TASK_ID = '001-add-login';

function makeTask(projectId: string): Task {
  return {
    id: TASK_ID,
    specId: TASK_ID,
    projectId,
    title: 'Add login',
    description: 'Add a login page',
    status: 'in_progress' as TaskStatus,
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Task;
}

describe('task actions carry the board project', () => {
  let store: typeof import('../task-store');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    store = await import('../task-store');
    // The board shows project-b's tasks, which is the project every call below belongs to
    store.useTaskStore.getState().setTasks([makeTask('project-b')]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the task\'s own project with start, stop, retry, review, status, running check and delete', async () => {
    store.startTask(TASK_ID);
    store.stopTask(TASK_ID);
    await store.retryTask(TASK_ID);
    await store.submitReview(TASK_ID, false, 'Please use the shared helper');
    await store.persistTaskStatus(TASK_ID, 'backlog');
    await store.checkTaskRunning(TASK_ID);
    await store.deleteTask(TASK_ID);

    expect(api.startTask).toHaveBeenCalledWith(TASK_ID, undefined, 'project-b');
    expect(api.stopTask).toHaveBeenCalledWith(TASK_ID, 'project-b');
    expect(api.retryTask).toHaveBeenCalledWith(TASK_ID, 'project-b');
    expect(api.submitReview).toHaveBeenCalledWith(
      TASK_ID,
      false,
      'Please use the shared helper',
      undefined,
      undefined,
      'project-b'
    );
    expect(api.updateTaskStatus).toHaveBeenCalledWith(TASK_ID, 'backlog', undefined, 'project-b');
    expect(api.checkTaskRunning).toHaveBeenCalledWith(TASK_ID, 'project-b');
    expect(api.deleteTask).toHaveBeenCalledWith(TASK_ID, 'project-b');
  });

  it('prefers the project the caller passes over the one in the store', async () => {
    // A caller with the task in hand (a card, the task dialog) knows its project without a lookup
    store.stopTask(TASK_ID, 'project-c');
    store.startTask(TASK_ID, undefined, 'project-c');
    await store.checkTaskRunning(TASK_ID, 'project-c');

    expect(api.stopTask).toHaveBeenCalledWith(TASK_ID, 'project-c');
    expect(api.startTask).toHaveBeenCalledWith(TASK_ID, undefined, 'project-c');
    expect(api.checkTaskRunning).toHaveBeenCalledWith(TASK_ID, 'project-c');
  });

  it('falls back to the window\'s active project for a task the store does not hold', async () => {
    const { useProjectStore } = await import('../project-store');
    useProjectStore.setState({
      projects: [{ id: 'project-b', name: 'Project B', path: '/projects/b' } as never],
      activeProjectId: 'project-b',
    });
    store.useTaskStore.getState().setTasks([]);

    store.stopTask(TASK_ID);

    expect(api.stopTask).toHaveBeenCalledWith(TASK_ID, 'project-b');
  });
});
