/**
 * Queue auto-promotion end to end in the main process: the task state machine reports
 * status changes, the task queue starts queued tasks that fit the parallel task limit.
 *
 * Regression for "tasks in the Queue don't move to In Progress while In Progress has
 * free slots": promotion used to live in the Kanban view, which only reacted to a task
 * leaving In Progress while the board was open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskStateManager } from '../task-state-manager';
import { TaskQueue } from '../services/task-queue';
import { XSTATE_ACTIVE_STATES } from '../../shared/state-machines';
import type { Task, TaskStatus, Project } from '../../shared/types';

vi.mock('../ipc-handlers/utils', () => ({
  safeSendToRenderer: vi.fn()
}));

vi.mock('../ipc-handlers/task/plan-file-utils', () => ({
  getPlanPath: vi.fn(() => '/mock/path/implementation_plan.json'),
  persistPlanStatusAndReasonSync: vi.fn()
}));

vi.mock('../worktree-paths', () => ({
  findTaskWorktree: vi.fn(() => null)
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false)
}));

const project = { id: 'p1', name: 'P', path: '/p' } as Project;

function makeTask(id: string, status: TaskStatus, createdAt: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...overrides
  } as Task;
}

describe('queue auto-promotion (main process)', () => {
  let manager: TaskStateManager;
  let queue: TaskQueue;
  let tasks: Task[];
  let maxParallel: number;

  /** Wire the queue like registerTaskExecutionHandlers does */
  function wire(): void {
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: () => tasks,
      getMaxParallelTasks: () => maxParallel,
      startTask: async (taskId) => {
        // Same as the TASK_START flow for a queued task
        const task = tasks.find((t) => t.id === taskId)!;
        manager.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
        return XSTATE_ACTIVE_STATES.has(manager.getCurrentState(taskId) ?? '');
      },
      debounceMs: 10
    });
    manager.setStatusChangeListener((taskId, status, projectId) => {
      // The real manager persists the status before emitting it
      const task = tasks.find((t) => t.id === taskId);
      if (task) task.status = status;
      queue.request(projectId);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TaskStateManager();
    queue = new TaskQueue();
    maxParallel = 1;
    wire();
  });

  afterEach(() => {
    queue.dispose();
    manager.clearAllTasks();
    vi.useRealTimers();
  });

  it('starts the next queued task when a running task finishes', async () => {
    const running = makeTask('running', 'in_progress', 1, {
      executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 }
    });
    tasks = [running, makeTask('queued', 'queue', 2)];

    manager.handleUiEvent('running', { type: 'USER_STOPPED', hasPlan: true }, running, project);
    await vi.runAllTimersAsync();

    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['running', 'human_review'],
      ['queued', 'in_progress']
    ]);
  });

  it('starts the next queued task when a running task fails', async () => {
    const running = makeTask('running', 'in_progress', 1, {
      executionProgress: { phase: 'planning', phaseProgress: 0, overallProgress: 0 }
    });
    tasks = [running, makeTask('queued', 'queue', 2)];

    manager.handleProcessExited('running', 1, running, project);
    await vi.runAllTimersAsync();

    expect(tasks.find((t) => t.id === 'queued')?.status).toBe('in_progress');
  });

  it('starts queued tasks waiting from before (e.g. after an app restart) when requested', async () => {
    maxParallel = 2;
    tasks = [makeTask('a', 'queue', 1), makeTask('b', 'queue', 2), makeTask('c', 'queue', 3)];

    queue.request();
    await vi.runAllTimersAsync();

    // The top of the Queue column (newest first when nothing was arranged) starts first
    expect(tasks.map((t) => t.status)).toEqual(['queue', 'in_progress', 'in_progress']);
  });

  it('starts more queued tasks when the limit is raised', async () => {
    tasks = [makeTask('a', 'in_progress', 1), makeTask('b', 'queue', 2), makeTask('c', 'queue', 3)];

    queue.request('p1');
    await vi.runAllTimersAsync();
    expect(tasks.map((t) => t.status)).toEqual(['in_progress', 'queue', 'queue']);

    maxParallel = 3;
    queue.request();
    await vi.runAllTimersAsync();
    expect(tasks.map((t) => t.status)).toEqual(['in_progress', 'in_progress', 'in_progress']);
  });

  it('skips a task put on a rate-limit hold and starts the next one instead', async () => {
    const running = makeTask('running', 'in_progress', 1, {
      executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 }
    });
    tasks = [running, makeTask('queued', 'queue', 2)];

    // The hold is persisted before the machine moves the task to the queue
    running.rateLimitHold = { resetAt: '2099-01-01T00:00:00.000Z', message: 'limit', pausedAt: '2098-12-31T00:00:00.000Z' };
    manager.handleTaskEvent('running', {
      type: 'RATE_LIMIT_HOLD',
      taskId: 'running',
      specId: 'running',
      projectId: 'p1',
      timestamp: new Date().toISOString(),
      eventId: 'evt-hold',
      sequence: 0,
      resetAt: '2099-01-01T00:00:00.000Z',
      message: 'limit'
    } as Parameters<TaskStateManager['handleTaskEvent']>[1], running, project);
    await vi.runAllTimersAsync();

    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['running', 'queue'],
      ['queued', 'in_progress']
    ]);
  });
});
