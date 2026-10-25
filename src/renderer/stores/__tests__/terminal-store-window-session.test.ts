/**
 * The task an agent window is linked to follows the session its Claude Code turns to by itself
 * (/resume, /clear, claude --resume)
 */
import { describe, it, expect, vi } from 'vitest';
import { taskForWindowSession } from '../terminal-store';
import type { Task } from '../../../shared/types';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn() },
}));

const withSession = (id: string, sessionId: string) => ({ id, claudeRun: { sessionId } }) as unknown as Task;
const backlog = (id: string) => ({ id }) as unknown as Task;

const tasks = [withSession('task-a', 'session-a'), withSession('task-b', 'session-b'), backlog('task-c')];

describe('the task a window shows for the session it runs', () => {
  it("is the task whose session it is", () => {
    expect(taskForWindowSession(tasks, undefined, 'session-a')).toEqual({ taskId: 'task-a' });
    expect(taskForWindowSession(tasks, 'task-b', 'session-a')).toEqual({ taskId: 'task-a' });
  });

  it('stays as it is when the window already shows that task', () => {
    expect(taskForWindowSession(tasks, 'task-a', 'session-a')).toBeUndefined();
  });

  it("is none once the window leaves the linked task's session", () => {
    expect(taskForWindowSession(tasks, 'task-a', 'session-other')).toEqual({ taskId: undefined });
  });

  it('keeps a task with no session yet, linked for its context', () => {
    expect(taskForWindowSession(tasks, 'task-c', 'session-other')).toBeUndefined();
  });

  it('leaves a window with no task alone for a session no task has', () => {
    expect(taskForWindowSession(tasks, undefined, 'session-other')).toBeUndefined();
  });
});
