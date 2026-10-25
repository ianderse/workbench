import { describe, it, expect } from 'vitest';
import type { Project, ProjectPriority, Task, TaskStatus } from '../../types';
import { blockingHigherPriorityProject, projectHasRunnableWork, resolveProjectPriority } from '../project-priority';
import { countRunningTasks, isRunningStatus } from '../running-tasks';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

function task(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return { id, specId: id, projectId: 'x', title: id, description: '', status, subtasks: [], logs: [], createdAt: new Date(NOW), updatedAt: new Date(NOW), ...overrides } as Task;
}
function project(id: string, priority?: ProjectPriority): Pick<Project, 'id' | 'name' | 'settings'> {
  return { id, name: `Project ${id}`, settings: { priority } as Project['settings'] };
}
const run = (projects: ReturnType<typeof project>[], tasks: Record<string, Task[]>, id: string) =>
  blockingHigherPriorityProject(projects, (pid) => tasks[pid] ?? [], projects.find((p) => p.id === id)!, { now: NOW })?.id;

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

describe('resolveProjectPriority', () => {
  it('defaults to normal', () => {
    expect(resolveProjectPriority(undefined)).toBe('normal');
    expect(resolveProjectPriority({ priority: 'bogus' })).toBe('normal');
    expect(resolveProjectPriority({ priority: 'high' })).toBe('high');
  });
});

describe('blockingHigherPriorityProject', () => {
  it('equal priority never blocks', () => {
    expect(run([project('a'), project('b')], { a: [task('1', 'in_progress')] }, 'b')).toBeUndefined();
    expect(run([project('a', 'high'), project('b', 'high')], { a: [task('1', 'in_progress')] }, 'b')).toBeUndefined();
  });

  it('a higher project with a running or reviewing task blocks', () => {
    const ps = [project('a', 'high'), project('b')];
    expect(run(ps, { a: [task('1', 'in_progress')] }, 'b')).toBe('a');
    expect(run(ps, { a: [task('1', 'ai_review')] }, 'b')).toBe('a');
  });

  it('a higher project with a startable queued task blocks', () => {
    expect(run([project('a', 'high'), project('b')], { a: [task('1', 'queue')] }, 'b')).toBe('a');
  });

  it('a higher project that has nothing to run does not block', () => {
    const ps = [project('a', 'high'), project('b')];
    expect(run(ps, { a: [task('1', 'human_review'), task('2', 'done'), task('3', 'backlog')] }, 'b')).toBeUndefined();
  });

  it('queued tasks that wait on a dependency or a rate limit do not block', () => {
    const ps = [project('a', 'high'), project('b')];
    const waiting = task('2', 'queue', { metadata: { dependsOnTaskIds: ['1'] } as Task['metadata'] });
    expect(run(ps, { a: [task('1', 'human_review'), waiting] }, 'b')).toBeUndefined();
    const held = task('3', 'queue', { rateLimitHold: { resetAt: new Date(NOW + 60_000).toISOString(), message: '', pausedAt: '' } });
    expect(run(ps, { a: [held] }, 'b')).toBeUndefined();
    expect(run(ps, { a: [task('1', 'done'), waiting] }, 'b')).toBe('a');
  });

  it('ignores archived tasks', () => {
    const ps = [project('a', 'high'), project('b')];
    const archived = { metadata: { archivedAt: new Date(NOW).toISOString() } as Task['metadata'] };
    expect(run(ps, { a: [task('1', 'in_progress', archived), task('2', 'queue', archived)] }, 'b')).toBeUndefined();
  });

  it('orders low < normal < high and handles several levels', () => {
    const ps = [project('h', 'high'), project('n', 'normal'), project('l', 'low')];
    const busy = (id: string) => ({ [id]: [task('1', 'in_progress')] });
    expect(run(ps, busy('l'), 'n')).toBeUndefined();
    expect(run(ps, busy('n'), 'l')).toBe('n');
    expect(run(ps, busy('n'), 'h')).toBeUndefined();
    expect(run(ps, { ...busy('h'), ...busy('n') }, 'l')).toBe('h');
    expect(run(ps, busy('h'), 'n')).toBe('h');
    expect(run(ps, {}, 'l')).toBeUndefined();
  });

  it('projectHasRunnableWork is false for an empty project', () => {
    expect(projectHasRunnableWork('a', [], { now: NOW })).toBe(false);
  });
});
