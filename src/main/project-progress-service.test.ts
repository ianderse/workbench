import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task } from '../shared/types';

const mocks = vi.hoisted(() => ({
  projects: new Map<string, Project>(),
  tasks: new Map<string, Task[]>(),
  getTasks: vi.fn((id: string): Task[] => mocks.tasks.get(id) ?? []),
  invalidate: vi.fn(),
  refresh: vi.fn(async (_project: Project, _tasks: Task[]): Promise<string | undefined> => undefined),
  warn: vi.fn(),
}));
vi.mock('./project-store', () => ({ projectStore: {
  getProject: (id: string) => mocks.projects.get(id),
  getTasks: mocks.getTasks,
  invalidateTasksCache: mocks.invalidate,
} }));
vi.mock('./project-progress', () => ({ refreshProjectProgress: mocks.refresh }));
vi.mock('./app-logger', () => ({ appLog: { warn: mocks.warn } }));

import { registerProjectProgressService } from './project-progress-service';
import { taskHooks } from './task-hooks';

const project = (id: string) => ({ id, path: `/fixture/${id}`, name: id, settings: {} }) as Project;
const task = (projectId: string, status: Task['status'] = 'done') => ({ id: '001-task', specId: '001-task', projectId, status }) as Task;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let stop: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.clear();
  mocks.tasks.clear();
  mocks.getTasks.mockImplementation((id) => mocks.tasks.get(id) ?? []);
  mocks.refresh.mockResolvedValue(undefined);
  stop = registerProjectProgressService();
});
afterEach(() => stop());

describe('project progress integration hooks', () => {
  it('registers once, performs no startup scan, and coalesces manual and autonomous events', async () => {
    expect(registerProjectProgressService()).toBe(stop);
    await flush();
    expect(mocks.getTasks).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    const p = project('one');
    const latest = [task(p.id)];
    mocks.projects.set(p.id, p);
    mocks.tasks.set(p.id, latest);
    taskHooks.emit('merged', { project: p, task: task(p.id, 'in_progress') });
    taskHooks.emit('auto-merged', { project: p, task: task(p.id, 'human_review'), into: 'release' });
    taskHooks.emit('integration-published', { project: p, branch: 'main', sha: 'abc123' });
    taskHooks.emit('state', { project: p, task: task(p.id, 'error'), status: 'error' });
    await flush();
    expect(mocks.getTasks).toHaveBeenCalledExactlyOnceWith(p.id);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(p.id);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(p, latest);
  });

  it('serializes each project and coalesces changes received during its active refresh', async () => {
    const p = project('one');
    mocks.projects.set(p.id, p);
    mocks.tasks.set(p.id, [task(p.id, 'queue')]);
    let finish!: () => void;
    mocks.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(undefined); }));
    taskHooks.emit('merged', { project: p, task: task(p.id) });
    await flush();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    taskHooks.emit('merged', { project: p, task: task(p.id) });
    taskHooks.emit('auto-merged', { project: p, task: task(p.id), into: 'develop' });
    mocks.tasks.set(p.id, [task(p.id)]);
    const current = { ...p, name: 'Updated project' };
    mocks.projects.set(p.id, current);
    await flush();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith(current, mocks.tasks.get(p.id));
  });

  it('does not hold an independent project behind another project refresh', async () => {
    const one = project('one');
    const two = project('two');
    mocks.projects.set(one.id, one);
    mocks.projects.set(two.id, two);
    let finish!: () => void;
    mocks.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(undefined); }));
    taskHooks.emit('merged', { project: one, task: task(one.id) });
    taskHooks.emit('merged', { project: two, task: task(two.id) });
    await flush();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith(two, []);
    finish();
    await flush();
  });

  it('logs a failed refresh without retrying and accepts a later integration event', async () => {
    const p = project('one');
    mocks.projects.set(p.id, p);
    mocks.refresh.mockRejectedValueOnce(new Error('read-only filesystem'));
    expect(() => taskHooks.emit('merged', { project: p, task: task(p.id) })).not.toThrow();
    await flush();
    await flush();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledOnce();
    taskHooks.emit('auto-merged', { project: p, task: task(p.id), into: 'main' });
    await flush();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it('preserves a failed record read and skips projects removed before a queued refresh', async () => {
    const p = project('one');
    mocks.projects.set(p.id, p);
    mocks.getTasks.mockImplementationOnce(() => { throw new Error('records unavailable'); });
    taskHooks.emit('merged', { project: p, task: task(p.id) });
    await flush();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
    taskHooks.emit('merged', { project: p, task: task(p.id) });
    mocks.projects.delete(p.id);
    await flush();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('disposes both hooks, cancels queued work and can be registered again', async () => {
    const p = project('one');
    mocks.projects.set(p.id, p);
    taskHooks.emit('merged', { project: p, task: task(p.id) });
    stop();
    stop();
    taskHooks.emit('auto-merged', { project: p, task: task(p.id), into: 'main' });
    await flush();
    expect(mocks.refresh).not.toHaveBeenCalled();
    stop = registerProjectProgressService();
    taskHooks.emit('merged', { project: p, task: task(p.id) });
    await flush();
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(p, []);
  });
});
