/**
 * The stuck-run safety net: 500 ms after a run's process exits, a timer forces the task out of an
 * active state if the run's own terminal event never arrived. A task id is only unique inside its
 * project, so the timers are keyed by both — keyed by the task alone, one project starting the task
 * cancelled another project's net (leaving the stuck card the net exists to prevent), and two runs
 * exiting within the window shared one slot so only one net ever fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { AgentManager } from '../../agent';
import type { Project, Task } from '../../../shared/types';

const mocks = vi.hoisted(() => ({
  currentState: 'coding' as string | undefined,
  handleUiEvent: vi.fn(),
  projects: [] as Project[],
  tasksByProject: new Map<string, Task[]>(),
}));

vi.mock('../../task-state-manager', () => ({
  taskStateManager: {
    configure: vi.fn(),
    setTaskCompletedListener: vi.fn(),
    setStatusChangeListener: vi.fn(),
    handleProcessExited: vi.fn(),
    handleTaskEvent: vi.fn(),
    handleUiEvent: mocks.handleUiEvent,
    getCurrentState: vi.fn(() => mocks.currentState),
    getLastSequence: vi.fn(() => 0),
    setLastSequence: vi.fn(),
  },
  XSTATE_ACTIVE_STATES: new Set(['coding']),
}));

vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: () => mocks.projects,
    getProject: (id: string) => mocks.projects.find((p) => p.id === id),
    getTasks: (projectId: string) => mocks.tasksByProject.get(projectId) ?? [],
    getCachedTasks: (projectId: string) => mocks.tasksByProject.get(projectId),
    updateTask: vi.fn(),
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../../file-watcher', () => ({
  fileWatcher: {
    on: vi.fn(),
    unwatch: vi.fn(async () => undefined),
    getCurrentPlan: vi.fn(() => null),
  },
}));

vi.mock('../../task-changelog-writer', () => ({ registerTaskChangelog: vi.fn() }));
vi.mock('../../graphify', () => ({ isGraphifyEnabled: async () => false, refreshGraphifyIndex: vi.fn() }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/ipc-utils', () => ({ safeSendToRenderer: vi.fn() }));
// The shared electron mock has no Notification, which the notification service reaches for
vi.mock('../../notification-service', () => ({
  notificationService: { notifyTaskCompleted: vi.fn(), notifyTaskFailed: vi.fn(), notifyTaskNeedsReview: vi.fn() },
}));

const { registerAgenteventsHandlers, cancelFallbackTimer } = await import('../agent-events-handlers');
const { taskStateManager } = await import('../../task-state-manager');

const TASK_ID = '001-add-login';

function makeProject(id: string): Project {
  return { id, name: id, path: `/projects/${id}`, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
}

function makeTask(projectId: string): Task {
  return {
    id: TASK_ID, specId: TASK_ID, projectId, title: 'Add login', description: '',
    status: 'in_progress', subtasks: [], logs: [], metadata: {},
    createdAt: new Date(), updatedAt: new Date(),
  } as Task;
}

let agentManager: EventEmitter;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.currentState = 'coding';
  mocks.projects = [makeProject('project-a'), makeProject('project-b')];
  mocks.tasksByProject.clear();
  mocks.tasksByProject.set('project-a', [makeTask('project-a')]);
  mocks.tasksByProject.set('project-b', [makeTask('project-b')]);

  agentManager = new EventEmitter();
  registerAgenteventsHandlers(agentManager as unknown as AgentManager, () => null);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Which projects the net fired for, in order */
const forcedProjects = () =>
  mocks.handleUiEvent.mock.calls.map((call) => (call[3] as Project | undefined)?.id);

describe('the stuck-run net of two projects holding the same task id', () => {
  it('arms a net per project, so both fire', () => {
    agentManager.emit('exit', TASK_ID, 1, 'claude', 'project-a');
    agentManager.emit('exit', TASK_ID, 1, 'claude', 'project-b');

    vi.advanceTimersByTime(600);

    expect(forcedProjects()).toEqual(['project-a', 'project-b']);
  });

  it('cancels only the named project’s net', () => {
    agentManager.emit('exit', TASK_ID, 1, 'claude', 'project-a');
    agentManager.emit('exit', TASK_ID, 1, 'claude', 'project-b');

    // What starting project-a's task again does: it must not disarm project-b's net
    cancelFallbackTimer(TASK_ID, 'project-a');
    vi.advanceTimersByTime(600);

    expect(forcedProjects()).toEqual(['project-b']);
  });

  it('cancels nothing when two projects hold a net and none is named', () => {
    agentManager.emit('exit', TASK_ID, 1, 'claude', 'project-a');
    agentManager.emit('exit', TASK_ID, 1, 'claude', 'project-b');

    cancelFallbackTimer(TASK_ID);
    vi.advanceTimersByTime(600);

    // Letting both nets fire is recoverable; cancelling the wrong project's is the stuck card
    expect(forcedProjects()).toEqual(['project-a', 'project-b']);
  });

  /**
   * The timer is filed under the project the exit resolved to, so the state it reads has to be that
   * project's. Reading with the event's raw id asks about no project when the event carried none,
   * and a task id two projects hold has no answer then - so the net would read the card as inactive
   * and never fire.
   */
  it('reads the state of the project its timer is filed under', () => {
    const reads: Array<string | undefined> = [];
    vi.mocked(taskStateManager.getCurrentState).mockImplementation((_taskId, projectId) => {
      reads.push(projectId);
      return 'coding';
    });

    // The exit carries no project; the handler resolves one from the task
    agentManager.emit('exit', TASK_ID, 1, 'claude', undefined);
    vi.advanceTimersByTime(600);

    // Every state read on this path names the project the exit resolved to - none asks with no
    // project, which is what a task id two projects hold cannot answer
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read === 'project-a')).toBe(true);
    expect(forcedProjects()).toEqual(['project-a']);
  });

  it('cancels a net armed without a project when a bare id names it', () => {
    agentManager.emit('exit', TASK_ID, 1, 'claude', undefined);

    cancelFallbackTimer(TASK_ID);
    vi.advanceTimersByTime(600);

    expect(forcedProjects()).toEqual([]);
  });
});
