/**
 * A task id is only unique inside its project, so two projects can both hold `001-add-login` with
 * a worktree of its own. The worktree handlers act on files and branches, which makes the wrong
 * project worse here than anywhere else: a discard removes a worktree and deletes its branch, so
 * resolving the project by searching for the task id can throw away another project's work.
 *
 * These tests go through the IPC handler and check that the project the renderer sent is the one
 * acted on. Both projects hold the task and the one being acted on comes second in the project
 * list, so a handler that searched for its own project would reach for the first one instead.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Project, Task } from '../../../../shared/types';
import { IPC_CHANNELS } from '../../../../shared/constants';

const mocks = vi.hoisted(() => ({
  projects: [] as Project[],
  tasksByProject: new Map<string, Task[]>(),
  cleanupWorktree: vi.fn(async () => ({ success: true, warnings: [] as string[] })),
  resetTaskRunState: vi.fn(),
  handleManualStatusChange: vi.fn(() => true),
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

// Every project keeps its own worktree for the task, under its own path
vi.mock('../../../worktree-paths', () => ({
  findTaskWorktree: (projectPath: string, specId: string) => `${projectPath}/.workbench/worktrees/tasks/${specId}`,
  getTaskWorktreeDir: (projectPath: string, specId: string) => `${projectPath}/.workbench/worktrees/tasks/${specId}`,
  isPathWithinBase: () => true,
}));

vi.mock('../../../utils/worktree-cleanup', () => ({
  cleanupWorktree: mocks.cleanupWorktree,
  discardTaskWorktree: vi.fn(async () => ({ success: true, warnings: [] })),
}));

vi.mock('../plan-file-utils', () => ({
  resetTaskRunState: mocks.resetTaskRunState,
  persistPlanStatus: vi.fn(async () => true),
  updateTaskMetadataFields: vi.fn(),
}));

vi.mock('../../../task-state-manager', () => ({
  taskStateManager: { handleManualStatusChange: mocks.handleManualStatusChange },
}));

vi.mock('../../utils', () => ({ safeSendToRenderer: vi.fn() }));

vi.mock('../../../utils/git-exec', () => ({ git: vi.fn(async () => ({ stdout: '', stderr: '' })) }));

vi.mock('../../../app-logger', () => ({
  appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerWorktreeHandlers } from '../worktree-handlers';
import { invokeIpcHandler } from '../../ipc-registry';

const TASK_ID = '001-add-login';

function makeProject(id: string): Project {
  return { id, name: id, path: `/projects/${id}`, autoBuildPath: '.workbench', settings: {} } as unknown as Project;
}

function makeTask(projectId: string): Task {
  return {
    id: TASK_ID,
    specId: TASK_ID,
    projectId,
    title: 'Add login',
    description: 'Add a login page',
    status: 'human_review',
    subtasks: [],
    logs: [],
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Task;
}

/** Both projects hold a task called `001-add-login`; `first` is the one a bare task id resolves to */
function setupProjects(first: string, second: string): void {
  mocks.projects = [makeProject(first), makeProject(second)];
  mocks.tasksByProject.clear();
  mocks.tasksByProject.set(first, [makeTask(first)]);
  mocks.tasksByProject.set(second, [makeTask(second)]);
}

beforeAll(() => {
  registerWorktreeHandlers(() => null);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cleanupWorktree.mockResolvedValue({ success: true, warnings: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('TASK_WORKTREE_DISCARD', () => {
  it('discards the worktree of the project the request came from', async () => {
    setupProjects('project-a', 'project-b');

    const result = await invokeIpcHandler<{ success: boolean }>(
      IPC_CHANNELS.TASK_WORKTREE_DISCARD,
      TASK_ID,
      false,
      'project-b'
    );

    expect(result.success).toBe(true);
    expect(mocks.cleanupWorktree).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupWorktree).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/projects/project-b',
      worktreePath: `/projects/project-b/.workbench/worktrees/tasks/${TASK_ID}`,
      specId: TASK_ID,
      deleteBranch: true,
    }));
    // The run state that is reset, and the card that moves back to Planning, belong to the same
    // project: nothing of project-a's task is touched
    expect(mocks.resetTaskRunState).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'project-b' }),
      expect.objectContaining({ projectId: 'project-b' })
    );
    expect(mocks.handleManualStatusChange).toHaveBeenCalledWith(
      TASK_ID,
      'backlog',
      expect.objectContaining({ projectId: 'project-b' }),
      expect.objectContaining({ id: 'project-b' })
    );
  });

  it('falls back to the first project holding the id when no project is sent', async () => {
    // The search is all a caller that names no project leaves to go on, and it answers with
    // project-a whichever project's worktree the discard was meant for
    setupProjects('project-a', 'project-b');

    await invokeIpcHandler(IPC_CHANNELS.TASK_WORKTREE_DISCARD, TASK_ID);

    expect(mocks.cleanupWorktree).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/projects/project-a',
    }));
  });

  it('reports the task as missing when the project it names does not hold it', async () => {
    // Scoped to the project named: a task id another project happens to hold is not an answer
    mocks.projects = [makeProject('project-a'), makeProject('project-b')];
    mocks.tasksByProject.clear();
    mocks.tasksByProject.set('project-a', [makeTask('project-a')]);

    const result = await invokeIpcHandler<{ success: boolean; error?: string }>(
      IPC_CHANNELS.TASK_WORKTREE_DISCARD,
      TASK_ID,
      false,
      'project-b'
    );

    expect(result).toEqual({ success: false, error: 'Task not found' });
    expect(mocks.cleanupWorktree).not.toHaveBeenCalled();
  });
});
