/**
 * A task id is only unique inside its project, so two projects can be running `001-add-login` at
 * the same time. AgentManager holds its runs per project and task and refuses a lookup that names
 * no project while two of them carry the task id - it has no run it could be meaning. These tests
 * go through the IPC handlers the board uses and check that each one names the project, so the
 * refusal is never what the user gets: stopping a task stops that project's run and leaves the
 * other one alone, and a task running in one project does not count as running in the other.
 *
 * The same goes for the two callers that are not the board: the Insights task tools, which act in
 * the chat's own project, and the start the board sends when the user presses Run.
 *
 * The project has to be the one the renderer sent. Searching the projects for the task id (what
 * `findTaskAndProject` does with no project) returns the first project that holds a task of that
 * id, running it or not, so every case below puts the running project second in the project list:
 * a handler that resolves its own project that way gets a genuine miss, and a handler given no
 * project at all must fall back to the bare task id, which still finds the single run.
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project, Task } from '../../../../shared/types';
import { IPC_CHANNELS } from '../../../../shared/constants';

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  tasksByProject: new Map<string, Task[]>(),
  scheduler: { configure: vi.fn() },
  queue: {
    configure: vi.fn(),
    request: vi.fn(),
    getBlockingProject: vi.fn(() => undefined),
    getHolds: vi.fn(() => []),
    requestLowerPriority: vi.fn(),
    runExclusive: vi.fn(async (_projectId: string, fn: () => unknown) => fn()),
  },
  stateManager: {
    getCurrentState: vi.fn((): string | undefined => 'coding'),
    handleUiEvent: vi.fn(),
    handleManualStatusChange: vi.fn(() => true),
    prepareForRestart: vi.fn(),
    clearTask: vi.fn(),
    setStatusChangeListener: vi.fn(),
  },
  clearRateLimitHold: vi.fn(),
  checkGitStatus: vi.fn(async () => ({ isGitRepo: true, hasCommits: true })),
}));

// The shared electron mock has no nativeImage, which crud-handlers imports for task attachments
vi.mock('electron', async (loadActual) => ({
  ...(await loadActual<Record<string, unknown>>()),
  nativeImage: { createFromPath: vi.fn() },
}));

vi.mock('../../../project-store', () => ({
  projectStore: {
    getProjects: () => mocks.projects,
    getProject: (id: string) => mocks.projects.find((p) => p.id === id),
    getTasks: (projectId: string) => mocks.tasksByProject.get(projectId) ?? [],
    getCachedTasks: (projectId: string) => mocks.tasksByProject.get(projectId),
    invalidateTasksCache: vi.fn(),
  },
}));

vi.mock('../../../file-watcher', () => ({
  fileWatcher: { watch: vi.fn(async () => undefined), unwatch: vi.fn(async () => undefined) },
}));

vi.mock('../../../task-state-manager', () => ({ taskStateManager: mocks.stateManager }));

vi.mock('../plan-file-utils', () => ({
  getPlanPath: vi.fn(() => '/project/.workbench/tasks/001-add-login/implementation_plan.json'),
  persistPlanStatus: vi.fn(async () => true),
  createPlanIfNotExists: vi.fn(async () => undefined),
  hasStartedImplementation: vi.fn(() => true),
  resetTaskToInitialState: vi.fn(async () => undefined),
  buildInitialPlan: vi.fn(() => ({})),
}));

vi.mock('../../../title-generator', () => ({ titleGenerator: { generateTitle: vi.fn(async () => 'Add login') } }));

vi.mock('../../../project-initializer', () => ({ checkGitStatus: mocks.checkGitStatus }));

vi.mock('../../../claude-profile-manager', () => ({
  initializeClaudeProfileManager: vi.fn(async () => ({ hasValidAuth: () => true })),
}));

vi.mock('../../../services/profile', () => ({ getAPIProfileEnv: vi.fn(async () => ({})) }));

vi.mock('../../../claude-code/task-runner', () => ({ loadClaudeRunInfo: vi.fn(() => null) }));

vi.mock('../../agent-events-handlers', () => ({ cancelFallbackTimer: vi.fn() }));

vi.mock('../../utils', () => ({ safeSendToRenderer: vi.fn() }));

vi.mock('../../../settings-utils', () => ({ readSettingsFile: vi.fn(() => ({ maxParallelTasks: 3 })) }));

vi.mock('../rate-limit-hold', () => ({ clearRateLimitHold: mocks.clearRateLimitHold }));

vi.mock('../../../services/rate-limit-resume-scheduler', () => ({
  rateLimitResumeScheduler: mocks.scheduler,
}));

vi.mock('../../../services/task-queue', () => ({ taskQueue: mocks.queue }));

vi.mock('../../../services/task-queue-order', () => ({ taskQueueOrder: { get: () => [], set: vi.fn() } }));

vi.mock('../../../task-hooks', () => ({ taskHooks: { emit: vi.fn(), on: vi.fn() } }));

vi.mock('../../../utils/worktree-cleanup', () => ({
  discardTaskWorktree: vi.fn(async () => ({ success: true, warnings: [] })),
}));

vi.mock('../../../task-log-service', () => ({ taskLogService: { clearCache: vi.fn() } }));

vi.mock('../../../task-run-archive', () => ({ archiveCurrentRun: vi.fn() }));

vi.mock('../../../worktree-paths', () => ({
  findTaskWorktree: vi.fn(() => null),
  isPathWithinBase: vi.fn(() => true),
  // The projects here have no directories on disk, so the spec-path scan finds nothing to delete
  getTaskWorktreeDir: vi.fn((projectPath: string) => path.join(projectPath, '.workbench', 'worktrees')),
}));

vi.mock('../../../utils/git-exec', () => ({ git: vi.fn(async () => ({ stdout: '', stderr: '' })) }));

vi.mock('../../../app-logger', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { AgentState } from '../../../agent/agent-state';
import type { AgentManager } from '../../../agent';
import type { StartTaskOptions } from '../../../agent/types';
import { registerTaskExecutionHandlers } from '../execution-handlers';
import { registerTaskCRUDHandlers } from '../crud-handlers';
import { invokeIpcHandler } from '../../ipc-registry';
import { runTaskTool } from '../../../insights/task-tools';
import { guardKey, localMerges, mergingPRs } from '../../../worktree/merge-guard';

const TASK_ID = '001-add-login';

/**
 * Stands in for AgentManager's run table. It keeps the runs in a real `AgentState`, which resolves
 * a task id the same way `AgentManager.keyOf` does - the project's own entry when one is named,
 * the single match when none is and nothing when two projects hold the id - so a handler that
 * drops the project here gets exactly the refusal the real manager would give it.
 */
class FakeAgentManager {
  private state = new AgentState();
  startTask = vi.fn(async (taskId: string, options: StartTaskOptions) => {
    // Through `addRun`, so a run started by a handler is as findable by a bare task id as one
    // started earlier: recording it only in the state would leave `projects` empty, and a bare
    // `killTask` would then stop nothing where the real manager resolves the single run
    this.addRun(taskId, options.project.id);
  });
  /** Answers as the real one does: the project of the run it stopped, or undefined for none */
  killTask = vi.fn((taskId: string, projectId?: string): string | undefined => {
    const owner = this.projectRunning(taskId, projectId);
    return owner && this.state.removeRunning(taskId, owner) ? owner : undefined;
  });

  /** The project whose run a lookup resolves to, with the same rules as `AgentManager.keyOf` */
  private projectRunning(taskId: string, projectId?: string): string | undefined {
    if (projectId) return this.state.isRunning(taskId, projectId) ? projectId : undefined;
    const holders = this.projects.filter((id) => this.state.isRunning(taskId, id));
    return holders.length === 1 ? holders[0] : undefined;
  }

  /** Projects this double has been told about, so a bare id can be judged ambiguous */
  private projects: string[] = [];
  isRunning = vi.fn((taskId: string, projectId?: string) => this.state.isRunning(taskId, projectId));

  /** A run started outside the handlers (the project's own board started it earlier) */
  addRun(taskId: string, projectId: string): void {
    this.state.addRunning(taskId, projectId);
    if (!this.projects.includes(projectId)) this.projects.push(projectId);
  }

  reset(): void {
    this.state.clear();
    this.projects = [];
  }
}

function makeProject(id: string): Project {
  return { id, name: id, path: `/projects/${id}`, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
}

function makeTask(projectId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    specId: TASK_ID,
    projectId,
    title: 'Add login',
    description: 'Add a login page',
    status: 'in_progress',
    subtasks: [],
    logs: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

const agentManager = new FakeAgentManager();

/** Both projects hold a task called `001-add-login`; `first` is the one a bare task id resolves to */
function setupProjects(first: string, second: string, tasks: Partial<Record<string, Task>> = {}): void {
  mocks.projects = [makeProject(first), makeProject(second)];
  mocks.tasksByProject.clear();
  mocks.tasksByProject.set(first, [tasks[first] ?? makeTask(first)]);
  mocks.tasksByProject.set(second, [tasks[second] ?? makeTask(second)]);
}

/** What the resume scheduler was handed at registration: a held task's task id and its project */
let resumeTask: (taskId: string, projectId: string) => Promise<void>;

/** What the task queue was handed at registration: the start of one promoted task of one project */
let queueStart: (taskId: string, projectId: string) => Promise<boolean>;

/** TASK_START drops the request when no window is open, so the handlers get a stand-in one */
const mainWindow = {} as unknown as import('electron').BrowserWindow;

// Registered once: every registration adds another listener per channel to the shared ipcMain
beforeAll(() => {
  registerTaskExecutionHandlers(agentManager as unknown as AgentManager, () => mainWindow);
  registerTaskCRUDHandlers(agentManager as unknown as AgentManager);
  resumeTask = mocks.scheduler.configure.mock.calls[0][0].resumeTask;
  queueStart = mocks.queue.configure.mock.calls[0][0].startTask;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateManager.getCurrentState.mockReturnValue('coding');
  mocks.checkGitStatus.mockResolvedValue({ isGitRepo: true, hasCommits: true });
  agentManager.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('TASK_STOP', () => {
  it('stops the run of the project the stop came from and leaves the other project running', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID, 'project-a');

    expect(agentManager.isRunning(TASK_ID, 'project-a')).toBe(false);
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(true);
    expect(mocks.stateManager.handleUiEvent).toHaveBeenCalledWith(
      TASK_ID,
      { type: 'USER_STOPPED', hasPlan: true },
      expect.objectContaining({ projectId: 'project-a' }),
      expect.objectContaining({ id: 'project-a' })
    );
  });

  it('stops the run of the project that sent the stop, not the first project holding the id', async () => {
    // Only the second project runs the task: a handler that searched for the project would name
    // the first one and stop nothing, which is the stop button doing nothing at all
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID, 'project-b');

    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(false);
    expect(mocks.stateManager.handleUiEvent).toHaveBeenCalledWith(
      TASK_ID,
      { type: 'USER_STOPPED', hasPlan: true },
      expect.objectContaining({ projectId: 'project-b' }),
      expect.objectContaining({ id: 'project-b' })
    );
  });

  it('stops the one run carrying the task id when no project is sent', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID);

    // The bare task id reached AgentManager, which has one run to stop; the project the task
    // search would have produced (project-a) runs nothing
    expect(agentManager.killTask).toHaveBeenCalledWith(TASK_ID, undefined);
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(false);
  });

  it('still stops the run when the task cannot be found in any project', async () => {
    mocks.projects = [];
    mocks.tasksByProject.clear();
    agentManager.addRun(TASK_ID, 'project-a');

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID);

    expect(agentManager.isRunning(TASK_ID, 'project-a')).toBe(false);
  });
});

describe('TASK_CHECK_RUNNING', () => {
  it('reports the asking project\'s run as running while another project runs the same id', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; data?: boolean }>(
      IPC_CHANNELS.TASK_CHECK_RUNNING,
      TASK_ID,
      'project-b'
    );

    expect(result).toEqual({ success: true, data: true });
  });

  it('reports a run in the second project as running', async () => {
    // "Not running" here is what makes a card offer to recover a task that is working
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; data?: boolean }>(
      IPC_CHANNELS.TASK_CHECK_RUNNING,
      TASK_ID,
      'project-b'
    );

    expect(result).toEqual({ success: true, data: true });
  });

  it('reports the single run as running when no project is sent', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; data?: boolean }>(
      IPC_CHANNELS.TASK_CHECK_RUNNING,
      TASK_ID
    );

    expect(agentManager.isRunning).toHaveBeenCalledWith(TASK_ID, undefined);
    expect(result).toEqual({ success: true, data: true });
  });

  it('answers "not running" for an id two projects run with no project sent', async () => {
    // Nothing else is honest: either run could be the one being asked about. The user gets the
    // answer by asking from a board, which sends its project
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; data?: boolean }>(
      IPC_CHANNELS.TASK_CHECK_RUNNING,
      TASK_ID
    );

    expect(result).toEqual({ success: true, data: false });
  });

  it('reports a task with no run as not running', async () => {
    setupProjects('project-a', 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; data?: boolean }>(
      IPC_CHANNELS.TASK_CHECK_RUNNING,
      TASK_ID,
      'project-a'
    );

    expect(result).toEqual({ success: true, data: false });
  });
});

describe('TASK_REVIEW', () => {
  const STILL_RUNNING = 'The task is still running. Stop it before requesting changes.';

  it('refuses to request changes while the sending project runs the task', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_REVIEW,
      TASK_ID,
      false,
      'Please use the shared helper',
      undefined,
      undefined,
      'project-b'
    );

    expect(result).toEqual({ success: false, error: STILL_RUNNING });
    expect(agentManager.startTask).not.toHaveBeenCalled();
  });

  /**
   * With no project sent, the revision runs in the project the task lookup settled on, so that is
   * the project whose run has to be idle. Asking AgentManager with no project at all would get the
   * refusal it gives an id two projects run - read here as "nothing is running" - and the revision
   * would be a second run over this project's live one.
   */
  it('refuses to request changes while the project it resolved is running the task', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_REVIEW,
      TASK_ID,
      false,
      'Please use the shared helper'
    );

    expect(agentManager.isRunning).toHaveBeenCalledWith(TASK_ID, 'project-a');
    expect(result).toEqual({ success: false, error: STILL_RUNNING });
    expect(agentManager.startTask).not.toHaveBeenCalled();
  });

  it('requests changes on the resolved project\'s idle task while another project runs the id', async () => {
    // The other project's run says nothing about this project's task: refusing here would leave a
    // reviewer unable to ask for changes because of a task they cannot see
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_REVIEW,
      TASK_ID,
      false,
      'Please use the shared helper'
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ mode: 'revise', project: expect.objectContaining({ id: 'project-a' }) })
    );
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(true);
  });
});

describe('TASK_RETRY', () => {
  const STILL_RUNNING = 'The task is still running. Stop it before retrying.';

  it('refuses to retry while the sending project runs the task', async () => {
    // Retry discards the worktree and its branch, so a missed run would lose a live run's work
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_RETRY,
      TASK_ID,
      'project-b'
    );

    expect(result).toEqual({ success: false, error: STILL_RUNNING });
  });

  it('refuses to retry while the project it resolved is running the task', async () => {
    // The retry discards the worktree of the project the task lookup settled on, so that project's
    // run is the one that has to be idle: asking with no project while two of them run the id gets
    // a refusal, and the retry would delete a live run's work
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_RETRY,
      TASK_ID
    );

    expect(agentManager.isRunning).toHaveBeenCalledWith(TASK_ID, 'project-a');
    expect(result).toEqual({ success: false, error: STILL_RUNNING });
  });
});

describe('TASK_UPDATE_STATUS', () => {
  it('stops the sending project\'s run when its task leaves In Progress', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean }>(
      IPC_CHANNELS.TASK_UPDATE_STATUS,
      TASK_ID,
      'backlog',
      undefined,
      'project-b'
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.killTask).toHaveBeenCalledWith(TASK_ID, 'project-b');
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(false);
  });

  it('starts the run of the project the card was moved on', async () => {
    setupProjects('project-a', 'project-b');

    const result = await invokeIpcHandler<{ success: boolean }>(
      IPC_CHANNELS.TASK_UPDATE_STATUS,
      TASK_ID,
      'in_progress',
      undefined,
      'project-b'
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ project: expect.objectContaining({ id: 'project-b' }) })
    );
  });

  it('does not start a second run when the project the card was moved on already runs the task', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean }>(
      IPC_CHANNELS.TASK_UPDATE_STATUS,
      TASK_ID,
      'in_progress',
      undefined,
      'project-b'
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.startTask).not.toHaveBeenCalled();
    expect(mocks.stateManager.prepareForRestart).not.toHaveBeenCalled();
  });

  /**
   * The handler acts on the project the task lookup settled on, so its run checks have to ask
   * about that project. With no project sent and two projects running the task id, asking
   * AgentManager with nothing gets its refusal: the move would read the live run as idle, skip
   * `prepareForRestart` and launch a second run on top of it.
   */
  it('does not launch a second run over the resolved project\'s live run when no project is sent', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean }>(
      IPC_CHANNELS.TASK_UPDATE_STATUS,
      TASK_ID,
      'in_progress'
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.isRunning).toHaveBeenCalledWith(TASK_ID, 'project-a');
    expect(agentManager.startTask).not.toHaveBeenCalled();
    expect(mocks.stateManager.prepareForRestart).not.toHaveBeenCalled();
  });

  /**
   * The other side of the same mistake: the project the card belongs to is idle, so moving its
   * card to In Progress has to start it, however many other projects are running a task of the
   * same spec id.
   */
  it('starts the resolved project\'s task while another project runs the same id', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean }>(
      IPC_CHANNELS.TASK_UPDATE_STATUS,
      TASK_ID,
      'in_progress'
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ project: expect.objectContaining({ id: 'project-a' }) })
    );
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(true);
  });
});

describe('TASK_DELETE', () => {
  const RUNNING_ERROR = 'Cannot delete a running task. Stop the task first.';

  it('refuses to delete a task that runs in its own project while another project runs the same id', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_DELETE,
      TASK_ID,
      'project-a'
    );

    expect(result).toEqual({ success: false, error: RUNNING_ERROR });
  });

  it('refuses to delete a task the sending project runs', async () => {
    // The delete tears down the spec dirs and the worktree a live run is still writing to
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_DELETE,
      TASK_ID,
      'project-b'
    );

    expect(result).toEqual({ success: false, error: RUNNING_ERROR });
  });

  /**
   * The delete removes the spec dirs and worktree of the project the task lookup settled on, so
   * the guard has to ask about that project. Asking with no project while two of them run the id
   * gets AgentManager's refusal, which reads as "not running" - and the delete would then tear
   * down the directories a live run is still writing to, which is the one thing the guard exists
   * to prevent.
   */
  it('refuses to delete while the project it resolved is running the task', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_DELETE,
      TASK_ID
    );

    expect(agentManager.isRunning).toHaveBeenCalledWith(TASK_ID, 'project-a');
    expect(result).toEqual({ success: false, error: RUNNING_ERROR });
  });

  it('deletes the resolved project\'s idle task while another project runs the same id', async () => {
    // The other project's run is not this task's: refusing on it would leave a task undeletable
    // for as long as a task of the same spec id runs somewhere the user cannot see
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_DELETE,
      TASK_ID
    );

    expect(result).toEqual({ success: true });
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(true);
  });
});

/**
 * Recovery rewrites the plan files of the project it resolves and forgets the task's state
 * machine, so it is the run of that project that has to be idle - which is why the task is
 * resolved before the run is looked up.
 */
describe('TASK_RECOVER_STUCK', () => {
  it('refuses to recover while the project it resolved is running the task', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_RECOVER_STUCK,
      TASK_ID
    );

    expect(agentManager.isRunning).toHaveBeenCalledWith(TASK_ID, 'project-a');
    expect(result).toMatchObject({
      success: false,
      error: 'Task is still running. Stop it first before recovering.',
    });
  });
});

/**
 * Editing a card writes to the project's own spec files, and `metadata.baseBranch` is among the
 * fields it writes - so an edit landing on another project both loses the user's change and decides
 * what that project's next run branches from. Real directories here, because what has to be proved
 * is which project's file on disk the handler opened.
 */
/**
 * The kill and the card have to land on the same project. The kill is deliberately asked by bare
 * task id when none was sent - it stops the single run carrying the id - so the card that follows
 * must be the one that run belonged to, not whichever project holds the id first.
 */
describe('TASK_STOP without a project', () => {
  it('moves the card of the project whose run it stopped', async () => {
    setupProjects('project-a', 'project-b');
    // Only the second project is running it, so the bare id resolves there unambiguously
    agentManager.addRun(TASK_ID, 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID);

    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(false);
    expect(mocks.stateManager.handleUiEvent).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ type: 'USER_STOPPED' }),
      expect.objectContaining({ projectId: 'project-b' }),
      expect.objectContaining({ id: 'project-b' })
    );
  });
});

describe('TASK_UPDATE', () => {
  let root: string;

  const planOf = (projectId: string) =>
    path.join(root, projectId, '.workbench', 'tasks', TASK_ID, 'implementation_plan.json');

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'task-update-scope-'));
    mocks.projects = [
      { id: 'project-a', name: 'a', path: path.join(root, 'project-a'), autoBuildPath: '.workbench', settings: {} },
      { id: 'project-b', name: 'b', path: path.join(root, 'project-b'), autoBuildPath: '.workbench', settings: {} },
    ] as unknown as Project[];
    mocks.tasksByProject.clear();
    for (const id of ['project-a', 'project-b']) {
      mocks.tasksByProject.set(id, [makeTask(id)]);
      mkdirSync(path.dirname(planOf(id)), { recursive: true });
      writeFileSync(planOf(id), JSON.stringify({ feature: 'Add login', description: `owned by ${id}` }), 'utf-8');
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the edit into the project the card belongs to', async () => {
    const result = await invokeIpcHandler(
      IPC_CHANNELS.TASK_UPDATE,
      TASK_ID,
      { description: 'edited on project-b' },
      'project-b'
    );

    expect(result).toMatchObject({ success: true });
    expect(JSON.parse(readFileSync(planOf('project-b'), 'utf-8')).description).toBe('edited on project-b');
    // project-a holds a task of the same id and comes first in the project list, which is what the
    // handler used to resolve to
    expect(JSON.parse(readFileSync(planOf('project-a'), 'utf-8')).description).toBe('owned by project-a');
  });

  it('refuses rather than editing another project\'s task of the same id', async () => {
    mocks.tasksByProject.delete('project-b');

    const result = await invokeIpcHandler(IPC_CHANNELS.TASK_UPDATE, TASK_ID, { description: 'x' }, 'project-b');

    expect(result).toMatchObject({ success: false });
    expect(JSON.parse(readFileSync(planOf('project-a'), 'utf-8')).description).toBe('owned by project-a');
  });
});

/**
 * The queue promotes one project's tasks at a time and says which. Its start reports back whether
 * the task is running by reading the state machine, so that read has to be of the project it
 * promoted: with the task id alone, another project's active run answered for it, the queue
 * recorded the promoted task as started, kept its slot filled and never came back to it.
 */
describe('the queue\'s start pass', () => {
  it('reads the state of the project it promoted', async () => {
    setupProjects('project-a', 'project-b');

    await queueStart(TASK_ID, 'project-b');

    expect(mocks.stateManager.getCurrentState).toHaveBeenCalledWith(TASK_ID, 'project-b');
    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ project: expect.objectContaining({ id: 'project-b' }) })
    );
  });
});

describe('TASK_START', () => {
  it('starts the task of the project the start came from, not the first project holding the id', async () => {
    setupProjects('project-a', 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-b');

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({
        project: expect.objectContaining({ id: 'project-b' }),
        task: expect.objectContaining({ projectId: 'project-b' }),
      })
    );
    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(true);
    expect(agentManager.isRunning(TASK_ID, 'project-a')).toBe(false);
  });

  it('names the project in every state the start reads and resets', async () => {
    // The start consults the machine to decide between resuming and planning, and clears the
    // tracking state of the run it is about to replace. Both are of the project it starts, never
    // of whichever project happens to hold a task of the same spec id
    setupProjects('project-a', 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-b');

    expect(mocks.stateManager.prepareForRestart).toHaveBeenCalledWith(TASK_ID, 'project-b');
    expect(mocks.stateManager.getCurrentState).toHaveBeenCalledWith(TASK_ID, 'project-b');
  });

  it('falls back to the first project holding the id when no project is sent', async () => {
    // What the board used to get: a start with no project can only be answered by searching, and
    // the search names project-a however the user came to press Run
    setupProjects('project-a', 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID);

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ project: expect.objectContaining({ id: 'project-a' }) })
    );
  });
});

describe('Insights task tools', () => {
  /**
   * The chat belongs to one project, so its tools send that project exactly as the board sends
   * the project of the card the user acted on. Without it a tool would act on whichever project
   * the task id search happens to name, and the run lookups would refuse an id two projects run
   * - the chat would report a failure instead of stopping anything.
   */
  const chatIn = (projectId: string) => ({ projectId, onTasksChanged: vi.fn() });

  it('stops the run in its own chat\'s project and leaves the other project running', async () => {
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-a');
    agentManager.addRun(TASK_ID, 'project-b');

    await runTaskTool(chatIn('project-b'), 'stop_task', { taskId: TASK_ID });

    expect(agentManager.isRunning(TASK_ID, 'project-b')).toBe(false);
    expect(agentManager.isRunning(TASK_ID, 'project-a')).toBe(true);
  });

  it('starts the task of its own chat\'s project', async () => {
    setupProjects('project-a', 'project-b', {
      'project-b': makeTask('project-b', { status: 'human_review' }),
    });

    await runTaskTool(chatIn('project-b'), 'start_task', { taskId: TASK_ID });

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ project: expect.objectContaining({ id: 'project-b' }) })
    );
    expect(agentManager.isRunning(TASK_ID, 'project-a')).toBe(false);
  });
});

describe('rate-limit resume', () => {
  /**
   * The resume scheduler is the one caller that knows the project a held task belongs to, so this
   * is where "running in one project" and "running in the other" can be told apart: project A's
   * run must not keep project B's task of the same id waiting for a rate limit that never was.
   */
  it('resumes a held task while another project runs the same task id', async () => {
    const held = makeTask('project-b', {
      status: 'queue',
      rateLimitHold: { resetAt: new Date(Date.now() - 1000).toISOString() },
    } as Partial<Task>);
    setupProjects('project-b', 'project-a', { 'project-b': held });
    agentManager.addRun(TASK_ID, 'project-a');

    await resumeTask(TASK_ID, 'project-b');

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ project: expect.objectContaining({ id: 'project-b' }) })
    );
    expect(agentManager.isRunning(TASK_ID, 'project-a')).toBe(true);
  });
});

/**
 * "Request changes" with "Start over" throws the attempt away and keeps the reviewer's notes for
 * the fresh run, which may first wait in the queue for a free slot. Those notes belong to one
 * project's task: held under the task id alone, a second project starting its own `001-add-login`
 * popped them, so that project's agent was told another project's reviewer notes were "what the
 * discarded attempt got wrong" - and the restart they were written for ran with nothing.
 */
describe('held restart feedback', () => {
  const FEEDBACK = 'The login button does nothing';

  /** Fills project-a's In Progress slots so its restart is queued instead of started at once */
  function fillProjectA(): void {
    const filler = ['002-filler', '003-filler', '004-filler'].map((id) =>
      makeTask('project-a', { id, specId: id, status: 'in_progress' })
    );
    mocks.tasksByProject.set('project-a', [makeTask('project-a'), ...filler]);
  }

  it('keeps the feedback for the project it was left in and starts another project\'s task without it', async () => {
    setupProjects('project-a', 'project-b');
    fillProjectA();

    const review = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_REVIEW,
      TASK_ID,
      false,
      FEEDBACK,
      undefined,
      { startOver: true },
      'project-a'
    );
    expect(review).toEqual({ success: true });
    // Queued behind the parallel limit: the notes are waiting for project-a's own start
    expect(agentManager.startTask).not.toHaveBeenCalled();

    // project-b now starts its own task of the same spec id. Nobody reviewed it, so its run must
    // be told nothing about an attempt in another project
    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-b');

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({
        project: expect.objectContaining({ id: 'project-b' }),
        feedback: undefined,
        feedbackImagePaths: undefined,
      })
    );

    // And project-a's restart, whenever its slot frees up, still gets the notes it was reset with
    agentManager.startTask.mockClear();
    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-a');

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({
        project: expect.objectContaining({ id: 'project-a' }),
        feedback: FEEDBACK,
        feedbackImagePaths: [],
      })
    );
  });

  it('starts the project whose restart queued the feedback with it, once only', async () => {
    setupProjects('project-a', 'project-b');
    fillProjectA();

    await invokeIpcHandler(
      IPC_CHANNELS.TASK_REVIEW, TASK_ID, false, FEEDBACK, undefined, { startOver: true }, 'project-a'
    );
    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-a');
    agentManager.startTask.mockClear();

    // The notes describe the attempt that was discarded, so the run after it has to start clean
    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-a');

    expect(agentManager.startTask).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ feedback: undefined })
    );
  });
});

/**
 * The plan watcher is keyed by project and task for the same reason the runs are: two projects
 * running a task of the same spec id each write their own implementation_plan.json, and each
 * needs its own watcher. The handlers therefore name the project they act on.
 */
describe('plan file watcher', () => {
  it('watches and unwatches the spec dir of the project the handler acted on', async () => {
    const { fileWatcher } = await import('../../../file-watcher');
    setupProjects('project-a', 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-b');

    expect(fileWatcher.watch).toHaveBeenCalledWith(
      TASK_ID,
      path.join('/projects/project-b', '.workbench', 'tasks', TASK_ID),
      'project-b'
    );

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID, 'project-b');

    expect(fileWatcher.unwatch).toHaveBeenCalledWith(TASK_ID, 'project-b');
  });

  it('closes the watcher of the project whose run a bare stop killed', async () => {
    // The kill is answered by task id when none was sent, and the watcher that closes has to be
    // the one belonging to the run that was stopped - not another project's live watch
    setupProjects('project-a', 'project-b');
    agentManager.addRun(TASK_ID, 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_STOP, TASK_ID);

    const { fileWatcher } = await import('../../../file-watcher');
    expect(fileWatcher.unwatch).toHaveBeenCalledWith(TASK_ID, 'project-b');
  });
});

describe('a task whose branch is being merged', () => {
  afterEach(() => {
    localMerges.clear();
    mergingPRs.clear();
  });

  it('is not started, retried, revised or moved to In Progress, while the same id in another project is', async () => {
    setupProjects('project-a', 'project-b', { 'project-a': makeTask('project-a', { status: 'human_review' }), 'project-b': makeTask('project-b', { status: 'human_review' }) });
    localMerges.add(guardKey('project-b', TASK_ID));

    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-b');
    const retry = await invokeIpcHandler<{ success: boolean; error?: string }>(IPC_CHANNELS.TASK_RETRY, TASK_ID, 'project-b');
    mergingPRs.add(guardKey('project-b', TASK_ID));
    localMerges.clear();
    const review = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_REVIEW, TASK_ID, false, 'More', undefined, undefined, 'project-b');
    const moved = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_UPDATE_STATUS, TASK_ID, 'in_progress', undefined, 'project-b');

    expect(agentManager.startTask).not.toHaveBeenCalled();
    expect(retry).toEqual({ success: false, error: expect.stringContaining('being merged') });
    expect(review).toEqual({ success: false, error: expect.stringContaining('pull request is being merged') });
    expect(moved).toEqual({ success: false, error: expect.stringContaining('pull request is being merged') });
    expect(mocks.stateManager.handleUiEvent).not.toHaveBeenCalled();

    await invokeIpcHandler(IPC_CHANNELS.TASK_START, TASK_ID, undefined, 'project-a');
    expect(agentManager.startTask).toHaveBeenCalledWith(TASK_ID, expect.objectContaining({ project: expect.objectContaining({ id: 'project-a' }) }));
  });
});
