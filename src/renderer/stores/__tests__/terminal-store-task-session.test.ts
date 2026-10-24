/**
 * Opening a task's Claude Code session in an agent window carries the task's project, because a
 * task id is only unique within a project and the main process needs the project to find the run
 * the window should follow.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPendingTaskSession, getTaskSessionRequest, useTerminalStore } from '../terminal-store';
import type { Task } from '../../../shared/types';

vi.mock('../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: { set: vi.fn(), clear: vi.fn(), get: vi.fn() },
}));

const PROJECT = '/home/user/project';

const task = {
  id: 'task-1',
  specId: '001-fix',
  projectId: 'project-a',
  title: 'Fix the thing',
  claudeRun: { sessionId: 'session-a', worktreePath: `${PROJECT}/.workbench/worktrees/tasks/001-fix` },
} as unknown as Task;

beforeEach(() => {
  useTerminalStore.setState({ terminals: [], activeTerminalId: null, maxTerminals: 3 });
});

describe("a task session request", () => {
  it("names the task's project by id as well as by path", () => {
    const request = getTaskSessionRequest(task, PROJECT);
    expect(request?.projectId).toBe('project-a');
    expect(request?.projectPath).toBe(PROJECT);
  });

  it('passes the project on to the window, which sends it with the resume request', () => {
    const request = getTaskSessionRequest(task, PROJECT);
    const terminal = useTerminalStore.getState().openTaskSession(request!);
    expect(terminal?.pendingTaskSession).toMatchObject({ taskId: 'task-1', projectId: 'project-a' });
  });

  it('builds the same pending session for a window moved onto the task', () => {
    // Terminal.tsx's task selector hands the request to the same builder, so a window that moves
    // onto a task sends the project too
    const request = getTaskSessionRequest(task, PROJECT);
    expect(buildPendingTaskSession(request!)).toEqual({
      taskId: 'task-1',
      projectId: 'project-a',
      sessionId: 'session-a',
      profileId: undefined,
      configDir: undefined
    });
  });
});
