import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Task, TaskStatus } from '../../../shared/types';
import {
  TaskQueue,
  getPromotableQueuedTasks,
  getUnmetDependencyIds,
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

describe('task dependencies', () => {
  const dependent = (deps: string[]) => makeTask('b', 'queue', { metadata: { dependsOnTaskIds: deps } as Task['metadata'] });

  it('waits for dependencies that are not done, including an open PR', () => {
    for (const status of ['backlog', 'queue', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'error'] as TaskStatus[]) {
      const tasks = [makeTask('a', status), dependent(['a'])];
      expect(getUnmetDependencyIds(tasks[1], tasks)).toEqual(['a']);
      expect(getPromotableQueuedTasks(tasks, NOW).map((t) => t.id)).not.toContain('b');
    }
  });

  it('is satisfied by done, archived or deleted dependencies', () => {
    const done = [makeTask('a', 'done'), dependent(['a'])];
    expect(getPromotableQueuedTasks(done, NOW).map((t) => t.id)).toEqual(['b']);
    const archived = [makeTask('a', 'human_review', { metadata: { archivedAt: 'x' } as Task['metadata'] }), dependent(['a'])];
    expect(getUnmetDependencyIds(archived[1], archived)).toEqual([]);
    const deleted = [dependent(['gone'])];
    expect(getPromotableQueuedTasks(deleted, NOW).map((t) => t.id)).toEqual(['b']);
  });

  it('starts independent tasks in parallel but holds dependents until the merge', async () => {
    const { queue, startTask, tasks } = createHarness({
      p1: [
        makeTask('a', 'queue', { createdAt: new Date(NOW - 3000) }),
        makeTask('c', 'queue', { createdAt: new Date(NOW - 2000) }),
        makeTask('b', 'queue', { createdAt: new Date(NOW - 1000), metadata: { dependsOnTaskIds: ['a'] } as Task['metadata'] }),
      ],
    }, 3);

    await queue.processProject('p1');
    expect(startTask.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'c']);

    tasks.p1.find((t) => t.id === 'a')!.status = 'pr_created';
    await queue.processProject('p1');
    expect(startTask).toHaveBeenCalledTimes(2);

    tasks.p1.find((t) => t.id === 'a')!.status = 'done';
    await queue.processProject('p1');
    expect(startTask.mock.calls.map((c) => c[0])).toContain('b');
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
    const isTaskRunning = vi.fn(() => true);
    queue.configure({
      listProjectIds: () => ['p1'],
      listTasks: () => [makeTask('q1', 'queue')],
      getMaxParallelTasks: () => 3,
      isTaskRunning,
      startTask,
    });

    await queue.processProject('p1');

    expect(startTask).not.toHaveBeenCalled();
    // A task id is only unique within a project, so the run it is asked about has to be named by
    // both - otherwise an id two projects are running reads as not running and this pass starts a
    // second run of its own project's task
    expect(isTaskRunning).toHaveBeenCalledWith('q1', 'p1');
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

  it('counts a task in AI review against the parallel limit', async () => {
    const { queue, startTask } = createHarness(
      { p1: [makeTask('a', 'in_progress'), makeTask('b', 'in_progress'), makeTask('c', 'ai_review'), makeTask('d', 'queue')] },
      3
    );
    await queue.processProject('p1');
    expect(startTask).not.toHaveBeenCalled();
  });

  it('starts a queued task once an AI-review task leaves for Human Review', async () => {
    const { tasks, queue, startTask } = createHarness(
      { p1: [makeTask('a', 'in_progress'), makeTask('b', 'in_progress'), makeTask('c', 'ai_review'), makeTask('d', 'queue')] },
      3
    );
    tasks.p1[2].status = 'human_review';
    await queue.processProject('p1');
    expect(startTask).toHaveBeenCalledWith('d', 'p1');
  });

  describe('project priority', () => {
    function priorityHarness() {
      const tasks: Record<string, Task[]> = {
        hi: [makeTask('h1', 'in_progress', { projectId: 'hi' })],
        lo: [makeTask('l1', 'queue', { projectId: 'lo' })],
      };
      const priorities: Record<string, 'high' | 'low'> = { hi: 'high', lo: 'low' };
      const holds: Array<[string, string | undefined]> = [];
      const startTask = vi.fn(async (taskId: string, projectId: string) => {
        tasks[projectId].find((t) => t.id === taskId)!.status = 'in_progress';
        return true;
      });
      const queue = new TaskQueue();
      queue.configure({
        listProjectIds: () => Object.keys(tasks),
        listTasks: (id) => tasks[id] ?? [],
        listProjects: () => Object.keys(tasks).map((id) => ({ id, name: `Project ${id}`, settings: { priority: priorities[id] } as never })),
        onHoldChange: (id, blockedBy) => holds.push([id, blockedBy?.id]),
        getMaxParallelTasks: () => 3,
        startTask,
        debounceMs: 10,
      });
      return { tasks, queue, startTask, holds };
    }

    it('holds an automatic start while a higher-priority project has work', async () => {
      const { queue, startTask, holds } = priorityHarness();
      await queue.processProject('lo');
      expect(startTask).not.toHaveBeenCalled();
      expect(holds).toEqual([['lo', 'hi']]);
      expect(queue.getBlockingProject('lo')?.name).toBe('Project hi');
    });

    it('the higher-priority project itself is never held', async () => {
      const { tasks, queue, startTask } = priorityHarness();
      tasks.hi.push(makeTask('h2', 'queue', { projectId: 'hi' }));
      await queue.processProject('hi');
      expect(startTask).toHaveBeenCalledWith('h2', 'hi');
    });

    it('a manual start does not go through the gate', async () => {
      const { queue, startTask } = priorityHarness();
      // A user start calls the start flow directly and never asks the queue; the queue still reports the hold
      await startTask('l1', 'lo');
      expect(startTask).toHaveBeenCalledTimes(1);
      expect(queue.getBlockingProject('lo')).toBeDefined();
    });

    it('wakes the lower-priority queue 2 s after the higher project frees', async () => {
      vi.useFakeTimers();
      const { tasks, queue, startTask, holds } = priorityHarness();
      await queue.processProject('lo');
      expect(startTask).not.toHaveBeenCalled();

      tasks.hi[0].status = 'human_review';
      queue.requestLowerPriority();
      await vi.advanceTimersByTimeAsync(1900);
      expect(startTask).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(startTask).toHaveBeenCalledWith('l1', 'lo');
      expect(holds.at(-1)).toEqual(['lo', undefined]);
      queue.dispose();
    });
  });

  it('ignores requests until configured', () => {
    const queue = new TaskQueue();
    expect(() => queue.request('p1')).not.toThrow();
  });
});
