/**
 * Tests for findTaskAndProject cross-project scoping.
 * Verifies that projectId prevents cross-project task contamination
 * when multiple projects have tasks with the same specId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findTaskAndProject } from '../shared';
import type { Task, Project } from '../../../../shared/types';

// Mock projectStore
const mockProjects: Project[] = [];
const mockTasksByProject: Map<string, Task[]> = new Map();

const logger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../app-logger', () => ({
  appLog: { warn: logger.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Which projects `getTasks` was asked to scan; `getTasks` reads the filesystem when it has to */
const scanned: string[] = [];

vi.mock('../../../project-store', () => ({
  projectStore: {
    getProjects: () => mockProjects,
    getTasks: (projectId: string) => {
      scanned.push(projectId);
      return mockTasksByProject.get(projectId) || [];
    },
    getCachedTasks: (projectId: string) => mockTasksByProject.get(projectId)
  }
}));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    specId: 'test-spec',
    projectId: 'project-1',
    title: 'Test Task',
    description: 'Test',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: `project-${Date.now()}`,
    name: 'Test Project',
    path: '/test/project',
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    ...overrides
  } as Project;
}

describe('findTaskAndProject', () => {
  beforeEach(() => {
    mockProjects.length = 0;
    mockTasksByProject.clear();
    // Without this the "does not warn" cases would pass on a warning left by an earlier test
    logger.warn.mockClear();
  });

  it('should find task by specId without projectId (backward compatibility)', () => {
    const project = createProject({ id: 'proj-1' });
    const task = createTask({ id: 'task-1', specId: 'write-to-file', projectId: 'proj-1' });

    mockProjects.push(project);
    mockTasksByProject.set('proj-1', [task]);

    const result = findTaskAndProject('write-to-file');
    expect(result.task).toBe(task);
    expect(result.project).toBe(project);
  });

  it('should scope search to specified project when projectId is provided', () => {
    const projectA = createProject({ id: 'proj-a', name: 'Project A' });
    const projectB = createProject({ id: 'proj-b', name: 'Project B' });

    const taskA = createTask({ id: 'task-a', specId: 'write-to-file', projectId: 'proj-a' });
    const taskB = createTask({ id: 'task-b', specId: 'write-to-file', projectId: 'proj-b' });

    mockProjects.push(projectA, projectB);
    mockTasksByProject.set('proj-a', [taskA]);
    mockTasksByProject.set('proj-b', [taskB]);

    // Without projectId - returns first match (Project A)
    const resultNoScope = findTaskAndProject('write-to-file');
    expect(resultNoScope.task).toBe(taskA);
    expect(resultNoScope.project).toBe(projectA);

    // With projectId for Project B - returns Project B's task
    const resultScopedB = findTaskAndProject('write-to-file', 'proj-b');
    expect(resultScopedB.task).toBe(taskB);
    expect(resultScopedB.project).toBe(projectB);

    // With projectId for Project A - returns Project A's task
    const resultScopedA = findTaskAndProject('write-to-file', 'proj-a');
    expect(resultScopedA.task).toBe(taskA);
    expect(resultScopedA.project).toBe(projectA);
  });

  it('should NOT fall back to other projects when projectId is provided but task not found', () => {
    const projectA = createProject({ id: 'proj-a' });
    const projectB = createProject({ id: 'proj-b' });

    const taskA = createTask({ id: 'task-a', specId: 'write-to-file', projectId: 'proj-a' });

    mockProjects.push(projectA, projectB);
    mockTasksByProject.set('proj-a', [taskA]);
    mockTasksByProject.set('proj-b', []);

    // Search Project B (which has no tasks) — should NOT find Project A's task
    const result = findTaskAndProject('write-to-file', 'proj-b');
    expect(result.task).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it('should return undefined when projectId refers to a non-existent project', () => {
    const project = createProject({ id: 'proj-1' });
    const task = createTask({ id: 'task-1', specId: 'write-to-file', projectId: 'proj-1' });

    mockProjects.push(project);
    mockTasksByProject.set('proj-1', [task]);

    // Search with a projectId that doesn't exist — should NOT fall back
    const result = findTaskAndProject('write-to-file', 'non-existent-project');
    expect(result.task).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it('should return undefined when task not found in any project', () => {
    const project = createProject({ id: 'proj-1' });
    mockProjects.push(project);
    mockTasksByProject.set('proj-1', []);

    const result = findTaskAndProject('nonexistent-task');
    expect(result.task).toBeUndefined();
    expect(result.project).toBeUndefined();
  });

  it('should find task by id as well as specId', () => {
    const project = createProject({ id: 'proj-1' });
    const task = createTask({ id: 'unique-uuid', specId: 'write-to-file', projectId: 'proj-1' });

    mockProjects.push(project);
    mockTasksByProject.set('proj-1', [task]);

    const result = findTaskAndProject('unique-uuid', 'proj-1');
    expect(result.task).toBe(task);
    expect(result.project).toBe(project);
  });

  it('should log a warning when two projects hold the id and no projectId was given', () => {
    // The caller gets the first project either way, so the log is the only trace that the answer
    // was a guess: a caller that acts on a task's run has to send the project instead. It goes
    // through appLog, because console output is invisible in a bundled Electron build
    const projectA = createProject({ id: 'proj-a' });
    const projectB = createProject({ id: 'proj-b' });

    mockProjects.push(projectA, projectB);
    mockTasksByProject.set('proj-a', [createTask({ specId: '001-add-login', projectId: 'proj-a' })]);
    mockTasksByProject.set('proj-b', [createTask({ specId: '001-add-login', projectId: 'proj-b' })]);

    const result = findTaskAndProject('001-add-login');

    expect(result.project).toBe(projectA);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exists in more than one project'));
  });

  it('should not warn when only one project holds the id', () => {
    mockProjects.push(createProject({ id: 'proj-a' }), createProject({ id: 'proj-b' }));
    mockTasksByProject.set('proj-a', [createTask({ specId: '001-add-login', projectId: 'proj-a' })]);
    mockTasksByProject.set('proj-b', []);

    findTaskAndProject('001-add-login');

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should log warning when provided projectId is not found', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockProjects.push(createProject({ id: 'proj-1' }));

    findTaskAndProject('some-task', 'ghost-project');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ghost-project'),
      // Flexible match on the rest of the message
    );
    warnSpy.mockRestore();
  });
});

/**
 * `getTasks` scans a project's spec directories synchronously whenever its cache has gone cold, and
 * the file-watcher events that reach this without a project arrive every few seconds while a task
 * writes its plan file. Looking past the project that answers would block the main process over and
 * over - CLAUDE.md's "never block the main process" rule is about exactly this.
 */
describe('findTaskAndProject without a projectId', () => {
  beforeEach(() => {
    scanned.length = 0;
  });

  it('stops scanning at the project that holds the task', () => {
    const [first, second, third] = ['project-1', 'project-2', 'project-3'].map((id) =>
      createProject({ id })
    );
    mockProjects.length = 0;
    mockProjects.push(first, second, third);
    mockTasksByProject.clear();
    mockTasksByProject.set(first.id, []);
    mockTasksByProject.set(second.id, [createTask({ specId: 'wanted', projectId: second.id })]);
    mockTasksByProject.set(third.id, [createTask({ specId: 'wanted', projectId: third.id })]);

    const { project } = findTaskAndProject('wanted');

    expect(project?.id).toBe(second.id);
    // The third project holds the id too, but nothing scanned it
    expect(scanned).toEqual([first.id, second.id]);
  });

  it('scans every project only when none of them holds the task', () => {
    const projects = ['project-1', 'project-2'].map((id) => createProject({ id }));
    mockProjects.length = 0;
    mockProjects.push(...projects);
    mockTasksByProject.clear();
    for (const p of projects) mockTasksByProject.set(p.id, []);

    expect(findTaskAndProject('missing').task).toBeUndefined();
    expect(scanned).toEqual(projects.map((p) => p.id));
  });
});
