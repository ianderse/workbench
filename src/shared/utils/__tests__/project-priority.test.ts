import { describe, it, expect } from 'vitest';
import type { Project, ProjectPriority, Task, TaskStatus } from '../../types';
import { getQueueHold, hasStartableQueuedTask, resolveProjectPriority, sortByProjectPriority } from '../project-priority';
import { countRunningTasks, isRunningStatus, reachedParallelCap } from '../running-tasks';
import { resolveGlobalMaxParallelTasks, resolveProjectMaxParallelTasks, DEFAULT_MAX_PARALLEL_TASKS } from '../../constants/task';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

function task(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return { id, specId: id, projectId: 'x', title: id, description: '', status, subtasks: [], logs: [], createdAt: new Date(NOW), updatedAt: new Date(NOW), ...overrides } as Task;
}
function project(id: string, priority?: ProjectPriority): { id: string; name: string; settings: Project['settings'] } {
  return { id, name: `Project ${id}`, settings: { priority } as Project['settings'] };
}

/** Hold for project `id`; caps: global total and optional per-project caps */
function holdFor(
  projects: ReturnType<typeof project>[],
  tasks: Record<string, Task[]>,
  id: string,
  globalMax = 8,
  projectMax: Record<string, number> = {}
) {
  return getQueueHold(
    {
      projects,
      tasksByProject: (pid) => tasks[pid] ?? [],
      runningCount: (pid) => countRunningTasks(tasks[pid] ?? []),
      globalMax,
      projectMax: (pid) => projectMax[pid],
    },
    projects.find((p) => p.id === id)!,
    { now: NOW }
  );
}
const running = (n: number, prefix = 'r'): Task[] => Array.from({ length: n }, (_, i) => task(`${prefix}${i}`, 'in_progress'));

describe('running tasks', () => {
  it('counts In Progress and AI Review, not archived or excluded ones', () => {
    expect(isRunningStatus('in_progress')).toBe(true);
    expect(isRunningStatus('ai_review')).toBe(true);
    expect(isRunningStatus('queue')).toBe(false);
    expect(isRunningStatus('human_review')).toBe(false);
    const archived = { metadata: { archivedAt: new Date(NOW).toISOString() } as Task['metadata'] };
    const tasks = [task('1', 'in_progress'), task('2', 'ai_review'), task('3', 'queue'), task('4', 'in_progress', archived)];
    expect(countRunningTasks(tasks)).toBe(2);
    expect(countRunningTasks(tasks, '2')).toBe(1);
  });
});

describe('parallel cap helpers', () => {
  it('global cap = app setting, default when unset; project cap only when set', () => {
    expect(resolveGlobalMaxParallelTasks(8)).toBe(8);
    expect(resolveGlobalMaxParallelTasks(undefined)).toBe(DEFAULT_MAX_PARALLEL_TASKS);
    expect(resolveProjectMaxParallelTasks(2)).toBe(2);
    expect(resolveProjectMaxParallelTasks(undefined)).toBeUndefined();
    expect(resolveProjectMaxParallelTasks(0)).toBeUndefined();
  });

  it('reports the global cap first, then the project cap', () => {
    expect(reachedParallelCap({ globalRunning: 7, projectRunning: 1, globalMax: 8 })).toBeUndefined();
    expect(reachedParallelCap({ globalRunning: 8, projectRunning: 1, globalMax: 8 })).toBe('global');
    expect(reachedParallelCap({ globalRunning: 3, projectRunning: 2, globalMax: 8, projectMax: 2 })).toBe('project');
    expect(reachedParallelCap({ globalRunning: 8, projectRunning: 2, globalMax: 8, projectMax: 2 })).toBe('global');
  });
});

describe('resolveProjectPriority', () => {
  it('defaults to normal', () => {
    expect(resolveProjectPriority(undefined)).toBe('normal');
    expect(resolveProjectPriority({ priority: 'bogus' })).toBe('normal');
    expect(resolveProjectPriority({ priority: 'high' })).toBe('high');
  });

  it('sorts highest priority first and keeps the order of equals', () => {
    const ps = [project('l', 'low'), project('n1'), project('h', 'high'), project('n2')];
    expect(sortByProjectPriority(ps).map((p) => p.id)).toEqual(['h', 'n1', 'n2', 'l']);
  });
});

describe('getQueueHold', () => {
  it('a higher project that is only running or reviewing does not hold a lower one', () => {
    const ps = [project('a', 'high'), project('b')];
    expect(holdFor(ps, { a: [task('1', 'in_progress'), task('2', 'ai_review')], b: [task('3', 'queue')] }, 'b')).toBeUndefined();
  });

  it('a higher project with a startable queued task goes first', () => {
    const ps = [project('a', 'high'), project('b')];
    expect(holdFor(ps, { a: [task('1', 'queue')], b: [task('2', 'queue')] }, 'b')).toEqual({ kind: 'project', projectId: 'a', name: 'Project a' });
    // The higher project itself is not held by the lower one
    expect(holdFor(ps, { a: [task('1', 'queue')], b: [task('2', 'queue')] }, 'a')).toBeUndefined();
  });

  it('queued tasks that wait on a dependency, a rate limit, or sit archived are not startable', () => {
    const ps = [project('a', 'high'), project('b')];
    const waiting = task('2', 'queue', { metadata: { dependsOnTaskIds: ['1'] } as Task['metadata'] });
    expect(holdFor(ps, { a: [task('1', 'human_review'), waiting] }, 'b')).toBeUndefined();
    const held = task('3', 'queue', { rateLimitHold: { resetAt: new Date(NOW + 60_000).toISOString(), message: '', pausedAt: '' } });
    expect(holdFor(ps, { a: [held] }, 'b')).toBeUndefined();
    expect(holdFor(ps, { a: [task('1', 'done'), waiting] }, 'b')?.kind).toBe('project');
    const archived = { metadata: { archivedAt: new Date(NOW).toISOString() } as Task['metadata'] };
    expect(holdFor(ps, { a: [task('4', 'queue', archived)] }, 'b')).toBeUndefined();
  });

  it('a higher project at its own cap has nothing startable', () => {
    const ps = [project('a', 'high'), project('b')];
    const tasks = { a: [...running(2), task('q', 'queue')] };
    expect(holdFor(ps, tasks, 'b', 8, { a: 2 })).toBeUndefined();
    expect(holdFor(ps, tasks, 'b', 8, { a: 3 })?.kind).toBe('project');
  });

  it('the global cap counts running tasks of all projects', () => {
    const ps = [project('a'), project('b')];
    const tasks = { a: running(5, 'a'), b: running(3, 'b') };
    expect(holdFor(ps, { ...tasks, b: [...tasks.b, task('q', 'queue')] }, 'b', 8)).toEqual({ kind: 'slots', used: 8, max: 8 });
    expect(holdFor(ps, tasks, 'b', 9)).toBeUndefined();
  });

  it("a project's own cap holds it even with global slots free", () => {
    const ps = [project('a')];
    expect(holdFor(ps, { a: running(2) }, 'a', 8, { a: 2 })).toEqual({ kind: 'projectCap', used: 2, max: 2 });
    expect(holdFor(ps, { a: running(1) }, 'a', 8, { a: 2 })).toBeUndefined();
  });

  it('equal priority never holds back', () => {
    expect(holdFor([project('a'), project('b')], { a: [task('1', 'queue')], b: [task('2', 'queue')] }, 'b')).toBeUndefined();
    expect(holdFor([project('a', 'high'), project('b', 'high')], { a: [task('1', 'queue')] }, 'b')).toBeUndefined();
  });

  it('orders low < normal < high', () => {
    const ps = [project('h', 'high'), project('n', 'normal'), project('l', 'low')];
    const queued = { h: [task('1', 'queue')], n: [task('2', 'queue')], l: [task('3', 'queue')] };
    expect(holdFor(ps, queued, 'l')).toMatchObject({ projectId: 'h' });
    expect(holdFor(ps, { n: queued.n, l: queued.l }, 'l')).toMatchObject({ projectId: 'n' });
    expect(holdFor(ps, queued, 'n')).toMatchObject({ projectId: 'h' });
    expect(holdFor(ps, queued, 'h')).toBeUndefined();
    expect(holdFor(ps, { l: queued.l }, 'n')).toBeUndefined();
  });

  it('hasStartableQueuedTask is false for an empty project', () => {
    expect(hasStartableQueuedTask('a', [], { now: NOW })).toBe(false);
  });
});
