import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Task, TaskStatus } from '../../../shared/types';
import {
  TaskQueue,
  getPromotableQueuedTasks,
  MAX_FAILED_STARTS_PER_PASS
} from '../task-queue';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

function makeTask(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p1',
    title: id,
    description: '',
    status,
    subtasks: [],
    logs: [],
    createdAt: new Date(NOW - 1000),
    updatedAt: new Date(NOW - 1000),
    ...overrides,
  } as Task;
}

/** Minimal project store: startTask moves the task to in_progress like the real start flow */
function createHarness(initial: Record<string, Task[]>, maxParallel = 3) {
  const tasks = initial;
  const startTask = vi.fn(async (taskId: string, projectId: string) => {
    const task = tasks[projectId].find((t) => t.id === taskId);
    if (!task || task.status !== 'queue') return false;
    task.status = 'in_progress';
    return true;
  });
  const queue = new TaskQueue();
  queue.configure({
    listProjectIds: () => Object.keys(tasks),
    listTasks: (projectId) => tasks[projectId] ?? [],
    getMaxParallelTasks: () => maxParallel,
    startTask,
    debounceMs: 10,
  });
  return { tasks, queue, startTask };
}

describe('task queue helpers', () => {

  it('lists queued tasks top of the column first (newest first when unarranged), without held or archived ones', () => {
    const tasks = [
      makeTask('new', 'queue', { createdAt: new Date(NOW - 10) }),
      makeTask('old', 'queue', { createdAt: new Date(NOW - 5000) }),
      makeTask('held', 'queue', { rateLimitHold: { resetAt: new Date(NOW + 60_000).toISOString(), message: '', pausedAt: '' } }),
      makeTask('hold-expired', 'queue', {
        createdAt: new Date(NOW - 100),
        rateLimitHold: { resetAt: new Date(NOW - 60_000).toISOString(), message: '', pausedAt: '' },
      }),
      makeTask('archived', 'queue', { metadata: { archivedAt: new Date().toISOString() } as Task['metadata'] }),
      makeTask('backlog', 'backlog'),
    ];
    expect(getPromotableQueuedTasks(tasks, NOW).map((t) => t.id)).toEqual(['new', 'hold-expired', 'old']);
    // A saved Queue order puts arranged tasks after unarranged ones, in their saved order
    expect(getPromotableQueuedTasks(tasks, NOW, ['old', 'new']).map((t) => t.id)).toEqual(['hold-expired', 'old', 'new']);
  });
});

describe('TaskQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts queued tasks when In Progress is empty, top of the column first, up to the limit', async () => {
    const { queue, startTask, tasks } = createHarness({
      p1: [
        makeTask('q3', 'queue', { createdAt: new Date(NOW - 3000) }),
        makeTask('q1', 'queue', { createdAt: new Date(NOW - 5000) }),
        makeTask('q4', 'queue', { createdAt: new Date(NOW - 2000) }),
        makeTask('q2', 'queue', { createdAt: new Date(NOW - 4000) }),
      ],
    }, 3);

    await queue.processProject('p1');

    expect(startTask.mock.calls.map((c) => c[0])).toEqual(['q4', 'q3', 'q2']);
    expect(tasks.p1.find((t) => t.id === 'q1')?.status).toBe('queue');
  });

  it('starts the top task of the saved Queue order first', async () => {
    const { queue, tasks, startTask } = createHarness({
      p1: [makeTask('a', 'queue'), makeTask('b', 'queue'), makeTask('c', 'queue')],
    }, 1);
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: (projectId) => tasks[projectId] ?? [],
      getMaxParallelTasks: () => 1,
      getQueueOrder: () => ['c', 'a', 'b'],
      startTask,
    });

    await queue.processProject('p1');

    expect(startTask.mock.calls.map((c) => c[0])).toEqual(['c']);
  });

  it('fills only the free slots', async () => {
    const { queue, startTask } = createHarness({
      p1: [makeTask('running', 'in_progress'), makeTask('q1', 'queue'), makeTask('q2', 'queue')],
    }, 2);

    await queue.processProject('p1');

    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it('does nothing at capacity', async () => {
    const { queue, startTask } = createHarness({
      p1: [makeTask('r1', 'in_progress'), makeTask('q1', 'queue')],
    }, 1);

    await queue.processProject('p1');

    expect(startTask).not.toHaveBeenCalled();
  });

  it('skips tasks waiting for a rate limit to reset', async () => {
    const { queue, startTask } = createHarness({
      p1: [
        makeTask('held', 'queue', {
          createdAt: new Date(NOW - 9000),
          rateLimitHold: { resetAt: new Date(NOW + 60_000).toISOString(), message: '', pausedAt: '' },
        }),
        makeTask('q1', 'queue'),
      ],
    }, 3);

    await queue.processProject('p1');

    expect(startTask.mock.calls.map((c) => c[0])).toEqual(['q1']);
  });

  it('skips tasks that already have a run', async () => {
    const { queue, startTask } = createHarness({ p1: [makeTask('q1', 'queue')] });
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: () => [makeTask('q1', 'queue')],
      getMaxParallelTasks: () => 3,
      isTaskRunning: () => true,
      startTask,
    });

    await queue.processProject('p1');

    expect(startTask).not.toHaveBeenCalled();
  });

  it('counts tasks it started even before their status is written, so it never exceeds the limit', async () => {
    const tasks = [makeTask('q1', 'queue'), makeTask('q2', 'queue'), makeTask('q3', 'queue')];
    const startTask = vi.fn(async (_taskId: string) => true); // status never changes in listTasks
    const queue = new TaskQueue();
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: () => tasks,
      getMaxParallelTasks: () => 2,
      startTask,
    });

    await queue.processProject('p1');

    expect(startTask.mock.calls.map((c) => c[0])).toEqual(['q1', 'q2']);
  });

  it('skips a task that fails to start and stops after repeated failures', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      makeTask(`q${i}`, 'queue', { createdAt: new Date(NOW - 10_000 + i) })
    );
    const startTask = vi.fn(async () => false);
    const queue = new TaskQueue();
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: () => tasks,
      getMaxParallelTasks: () => 3,
      startTask,
    });

    await queue.processProject('p1');

    expect(startTask).toHaveBeenCalledTimes(MAX_FAILED_STARTS_PER_PASS);
  });

  it('moves on to the next task when one fails to start', async () => {
    const { queue, tasks } = createHarness({
      p1: [makeTask('bad', 'queue', { createdAt: new Date(NOW - 10) }), makeTask('good', 'queue')],
    }, 1);
    const startTask = vi.fn(async (taskId: string) => {
      if (taskId === 'bad') throw new Error('boom');
      tasks.p1.find((t) => t.id === taskId)!.status = 'in_progress';
      return true;
    });
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: (projectId) => tasks[projectId],
      getMaxParallelTasks: () => 1,
      startTask,
    });

    await queue.processProject('p1');

    expect(startTask.mock.calls.map((c) => c[0])).toEqual(['bad', 'good']);
    expect(tasks.p1.find((t) => t.id === 'good')?.status).toBe('in_progress');
  });

  it('coalesces requests and never starts a task twice when triggers overlap', async () => {
    const { queue, startTask, tasks } = createHarness({
      p1: [makeTask('q1', 'queue'), makeTask('q2', 'queue')],
    }, 3);
    // Slow start: the status changes only after the start resolves
    startTask.mockImplementation(async (taskId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      tasks.p1.find((t) => t.id === taskId)!.status = 'in_progress';
      return true;
    });

    queue.request('p1');
    queue.request('p1');
    queue.request();
    const direct = queue.processProject('p1');
    await vi.advanceTimersByTimeAsync(10);
    queue.request('p1');
    await vi.runAllTimersAsync();
    await direct;

    expect(startTask.mock.calls.map((c) => c[0]).sort()).toEqual(['q1', 'q2']);
  });

  it('processes every project when no project is named', async () => {
    const { queue, startTask } = createHarness({
      p1: [makeTask('a', 'queue')],
      p2: [makeTask('b', 'queue', { projectId: 'p2' })],
    });

    queue.request();
    await vi.runAllTimersAsync();

    expect(startTask.mock.calls).toEqual(expect.arrayContaining([['a', 'p1'], ['b', 'p2']]));
  });

  it('runs exclusive operations after a pass in progress (e.g. a rate-limit resume)', async () => {
    const order: string[] = [];
    const { queue, startTask, tasks } = createHarness({ p1: [makeTask('q1', 'queue')] }, 1);
    startTask.mockImplementation(async (taskId: string) => {
      order.push('start:begin');
      await new Promise((resolve) => setTimeout(resolve, 20));
      tasks.p1.find((t) => t.id === taskId)!.status = 'in_progress';
      order.push('start:end');
      return true;
    });

    const pass = queue.processProject('p1');
    const resume = queue.runExclusive('p1', () => {
      order.push('resume');
    });
    await vi.runAllTimersAsync();
    await Promise.all([pass, resume]);

    expect(order).toEqual(['start:begin', 'start:end', 'resume']);
  });

  it('ignores requests until configured', () => {
    const queue = new TaskQueue();
    expect(() => queue.request('p1')).not.toThrow();
  });
});
