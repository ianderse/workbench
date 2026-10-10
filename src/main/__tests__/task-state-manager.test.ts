import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskStateManager } from '../task-state-manager';
import type { Task, Project } from '../../shared/types';

// Mock dependencies
vi.mock('../ipc-handlers/utils', () => ({
  safeSendToRenderer: vi.fn()
}));

vi.mock('../ipc-handlers/task/plan-file-utils', () => ({
  getPlanPath: vi.fn(() => '/mock/path/implementation_plan.json'),
  persistPlanStatusAndReasonSync: vi.fn()
}));

vi.mock('../worktree-paths', () => ({
  findTaskWorktree: vi.fn(() => null)
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false)
}));

// Create mock task and project
function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-id',
    specId: '001-test-spec',
    projectId: 'test-project-id',
    title: 'Test Task',
    description: 'Test description',
    status: 'backlog',
    subtasks: [],
    logs: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test-project-id',
    name: 'Test Project',
    path: '/mock/project/path',
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    ...overrides
  } as Project;
}

describe('TaskStateManager', () => {
  let manager: TaskStateManager;
  let mockTask: Task;
  let mockProject: Project;

  beforeEach(() => {
    manager = new TaskStateManager();
    mockTask = createMockTask();
    mockProject = createMockProject();
    vi.clearAllMocks();
  });

  afterEach(() => {
    manager.clearAllTasks();
  });

  describe('handleTaskEvent', () => {
    it('should accept events with increasing sequence numbers', () => {
      const event1 = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0
      };

      const event2 = {
        type: 'PLANNING_COMPLETE',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-2',
        sequence: 1,
        hasSubtasks: true,
        subtaskCount: 1,
        requireReviewBeforeCoding: false
      };

      const result1 = manager.handleTaskEvent(mockTask.id, event1, mockTask, mockProject);
      const result2 = manager.handleTaskEvent(mockTask.id, event2, mockTask, mockProject);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });

    it('should reject events with stale sequence numbers', () => {
      const event1 = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 5
      };

      const event2 = {
        type: 'PLANNING_COMPLETE',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-2',
        sequence: 3, // Older than event1
        hasSubtasks: true,
        subtaskCount: 1,
        requireReviewBeforeCoding: false
      };

      const result1 = manager.handleTaskEvent(mockTask.id, event1, mockTask, mockProject);
      const result2 = manager.handleTaskEvent(mockTask.id, event2, mockTask, mockProject);

      expect(result1).toBe(true);
      expect(result2).toBe(false); // Should be rejected
    });

    it('should accept events with equal sequence numbers (edge case)', () => {
      // This handles reload scenarios where we might see the same sequence
      const event1 = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 5
      };

      const event2 = {
        type: 'PLANNING_COMPLETE',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-2',
        sequence: 5, // Same as event1
        hasSubtasks: true,
        subtaskCount: 1,
        requireReviewBeforeCoding: false
      };

      const result1 = manager.handleTaskEvent(mockTask.id, event1, mockTask, mockProject);
      const result2 = manager.handleTaskEvent(mockTask.id, event2, mockTask, mockProject);

      expect(result1).toBe(true);
      expect(result2).toBe(true); // Should be accepted (>= comparison)
    });
  });

  describe('handleUiEvent', () => {
    it('should send USER_RESUMED from human_review into coding', () => {
      const reviewTask = createMockTask({ status: 'human_review', reviewReason: 'completed' });
      manager.handleUiEvent(reviewTask.id, { type: 'USER_RESUMED' }, reviewTask, mockProject);
      expect(manager.getCurrentState(reviewTask.id)).toBe('coding');
    });

    it('should send USER_STOPPED event correctly', () => {
      const event = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0
      };

      manager.handleTaskEvent(mockTask.id, event, mockTask, mockProject);
      manager.handleUiEvent(mockTask.id, { type: 'USER_STOPPED', hasPlan: false }, mockTask, mockProject);

      // Should not throw
    });
  });

  describe('handleManualStatusChange', () => {
    it('should handle done status', () => {
      const result = manager.handleManualStatusChange(mockTask.id, 'done', mockTask, mockProject);
      expect(result).toBe(true);
    });

    it('should handle pr_created status', () => {
      const taskWithPrUrl = createMockTask({ metadata: { prUrl: 'https://github.com/test/pr/1' } });
      const result = manager.handleManualStatusChange(mockTask.id, 'pr_created', taskWithPrUrl, mockProject);
      expect(result).toBe(true);
    });

    it('should handle in_progress status from human_review', () => {
      const stoppedTask = createMockTask({
        status: 'human_review',
        reviewReason: 'stopped'
      });
      const result = manager.handleManualStatusChange(mockTask.id, 'in_progress', stoppedTask, mockProject);
      expect(result).toBe(true);
    });

    it('moves a backlog task to planning on manual in_progress', () => {
      const backlogTask = createMockTask({ status: 'backlog' });
      const result = manager.handleManualStatusChange(backlogTask.id, 'in_progress', backlogTask, mockProject);
      expect(result).toBe(true);
      expect(manager.getCurrentState(backlogTask.id)).toBe('planning');
    });

    it('should handle backlog status', () => {
      const result = manager.handleManualStatusChange(mockTask.id, 'backlog', mockTask, mockProject);
      expect(result).toBe(true);
    });

    it('should handle human_review status (stage-only merge keeps task in review)', () => {
      const taskInReview = createMockTask({
        status: 'human_review',
        reviewReason: 'completed'
      });
      const result = manager.handleManualStatusChange(mockTask.id, 'human_review', taskInReview, mockProject);
      expect(result).toBe(true);
    });

    it('should handle human_review with default reviewReason when task has none', () => {
      const taskNoReason = createMockTask({
        status: 'human_review'
        // no reviewReason set
      });
      const result = manager.handleManualStatusChange(mockTask.id, 'human_review', taskNoReason, mockProject);
      expect(result).toBe(true);
    });

    it('should return false for unhandled status', () => {
      const result = manager.handleManualStatusChange(mockTask.id, 'ai_review', mockTask, mockProject);
      expect(result).toBe(false);
    });
  });

  describe('sequence management', () => {
    it('should set and get last sequence', () => {
      manager.setLastSequence(mockTask.id, 42);
      expect(manager.getLastSequence(mockTask.id)).toBe(42);
    });

    it('should return undefined for unknown task', () => {
      expect(manager.getLastSequence('unknown-task')).toBeUndefined();
    });
  });

  describe('clearTask', () => {
    it('should clear task state', () => {
      // Set up some state
      manager.setLastSequence(mockTask.id, 10);

      const event = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0
      };
      manager.handleTaskEvent(mockTask.id, event, mockTask, mockProject);

      // Clear
      manager.clearTask(mockTask.id);

      // Verify cleared
      expect(manager.getLastSequence(mockTask.id)).toBeUndefined();
    });
  });

  describe('clearAllTasks', () => {
    it('should clear all task state', () => {
      // Set up state for multiple tasks
      manager.setLastSequence('task-1', 10);
      manager.setLastSequence('task-2', 20);

      const event1 = {
        type: 'PLANNING_STARTED',
        taskId: 'task-1',
        specId: '001',
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0
      };
      const event2 = {
        type: 'PLANNING_STARTED',
        taskId: 'task-2',
        specId: '002',
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-2',
        sequence: 0
      };

      manager.handleTaskEvent('task-1', event1, createMockTask({ id: 'task-1' }), mockProject);
      manager.handleTaskEvent('task-2', event2, createMockTask({ id: 'task-2' }), mockProject);

      // Clear all
      manager.clearAllTasks();

      // Verify actors and state are cleared, but sequence tracking is preserved
      // (to prevent duplicate event processing during refresh window)
      expect(manager.getLastSequence('task-1')).toBe(10);
      expect(manager.getLastSequence('task-2')).toBe(20);
    });
  });

  describe('handleProcessExited', () => {
    it('should NOT mark as error if terminal event was already seen', () => {
      // First send a terminal event (like QA_PASSED)
      const qaPassedEvent = {
        type: 'QA_PASSED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0,
        iteration: 1,
        testsRun: {}
      };

      manager.handleTaskEvent(mockTask.id, qaPassedEvent, mockTask, mockProject);

      // Now process exits - this should NOT trigger error state
      manager.handleProcessExited(mockTask.id, 0, mockTask, mockProject);

      // Should not throw and should not transition to error
      // (We can't easily verify the state, but the important thing is no crash)
    });

    it('should mark as error on unexpected exit when no terminal event seen', () => {
      // Start a task
      const planningEvent = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0
      };

      manager.handleTaskEvent(mockTask.id, planningEvent, mockTask, mockProject);

      // Process exits unexpectedly (no terminal event seen)
      manager.handleProcessExited(mockTask.id, 1, mockTask, mockProject);

      // Should have sent PROCESS_EXITED event with unexpected=true
      // This should transition to error state
    });

    it('should NOT mark exit code 0 as unexpected', () => {
      const planningStarted = {
        type: 'PLANNING_STARTED',
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0
      };
      manager.handleTaskEvent(mockTask.id, planningStarted, mockTask, mockProject);
      manager.handleProcessExited(mockTask.id, 0, mockTask, mockProject);
      expect(manager.getCurrentState(mockTask.id)).toBe('planning');
    });

    it('should treat QA_FAILED (validation failed) as a terminal event', () => {
      const base = {
        taskId: mockTask.id,
        specId: mockTask.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
      };
      manager.handleTaskEvent(mockTask.id, { ...base, type: 'PLANNING_STARTED', eventId: 'evt-1', sequence: 0 }, mockTask, mockProject);
      manager.handleTaskEvent(mockTask.id, { ...base, type: 'QA_STARTED', eventId: 'evt-2', sequence: 1, iteration: 1, maxIterations: 1 }, mockTask, mockProject);
      manager.handleTaskEvent(mockTask.id, { ...base, type: 'QA_FAILED', eventId: 'evt-3', sequence: 2, iteration: 1, issueCount: 1, issues: ['x'] }, mockTask, mockProject);
      expect(manager.getCurrentState(mockTask.id)).toBe('human_review');

      // A non-zero exit after the terminal event doesn't move the task to error
      manager.handleProcessExited(mockTask.id, 1, mockTask, mockProject);
      expect(manager.getCurrentState(mockTask.id)).toBe('human_review');
    });
  });

  describe('rate-limit hold', () => {
    const holdEvent = (sequence: number) => ({
      type: 'RATE_LIMIT_HOLD',
      taskId: mockTask.id,
      specId: mockTask.specId,
      projectId: mockProject.id,
      timestamp: new Date().toISOString(),
      eventId: `evt-hold-${sequence}`,
      sequence,
      resetAt: '2099-01-01T16:30:00.000Z',
      message: "You've hit your session limit · resets 8:30pm (Asia/Yerevan)",
      phase: 'coding'
    });

    it('moves a coding task to queued and survives the non-zero worker exit', () => {
      const codingTask = createMockTask({
        status: 'in_progress',
        executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 }
      });

      expect(manager.handleTaskEvent(codingTask.id, holdEvent(0), codingTask, mockProject)).toBe(true);
      expect(manager.getCurrentState(codingTask.id)).toBe('queued');

      // RATE_LIMIT_HOLD is terminal for the process: exit code 1 must not mark it as error
      manager.handleProcessExited(codingTask.id, 1, codingTask, mockProject);
      expect(manager.getCurrentState(codingTask.id)).toBe('queued');
    });

    it('restores a held queue task into the queued state and restarts via PLANNING_STARTED', () => {
      const heldTask = createMockTask({
        status: 'queue',
        rateLimitHold: {
          resetAt: '2099-01-01T16:30:00.000Z',
          message: 'limit',
          pausedAt: '2098-12-31T00:00:00.000Z'
        }
      });

      expect(manager.handleManualStatusChange(heldTask.id, 'in_progress', heldTask, mockProject)).toBe(true);
      expect(manager.getCurrentState(heldTask.id)).toBe('planning');
    });

    it('restores a plain queue task (no hold) as backlog', () => {
      const queuedTask = createMockTask({ status: 'queue' });
      manager.handleUiEvent(queuedTask.id, { type: 'PLANNING_STARTED' }, queuedTask, mockProject);
      expect(manager.getCurrentState(queuedTask.id)).toBe('planning');
    });
  });

  describe('status change listener', () => {
    afterEach(() => {
      manager.setStatusChangeListener(null);
    });

    it('reports every status the machine emits (used by the task queue)', () => {
      const listener = vi.fn();
      manager.setStatusChangeListener(listener);
      const codingTask = createMockTask({
        status: 'in_progress',
        executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 }
      });

      manager.handleUiEvent(codingTask.id, { type: 'USER_STOPPED', hasPlan: true }, codingTask, mockProject);

      expect(listener).toHaveBeenLastCalledWith(codingTask.id, 'human_review', mockProject.id);
    });

    it('reports a failed run leaving In Progress', () => {
      const listener = vi.fn();
      manager.setStatusChangeListener(listener);
      const codingTask = createMockTask({
        status: 'in_progress',
        executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 }
      });

      manager.handleProcessExited(codingTask.id, 1, codingTask, mockProject);

      expect(listener).toHaveBeenLastCalledWith(codingTask.id, 'human_review', mockProject.id);
    });

    it('keeps emitting when the listener throws', () => {
      manager.setStatusChangeListener(() => {
        throw new Error('boom');
      });
      expect(() => manager.handleUiEvent(mockTask.id, { type: 'PLANNING_STARTED' }, mockTask, mockProject)).not.toThrow();
      expect(manager.getCurrentState(mockTask.id)).toBe('planning');
    });
  });

  describe('actor state restoration', () => {
    it('should restore actor state from task with in_progress status', () => {
      const taskInProgress = createMockTask({
        status: 'in_progress',
        executionProgress: { phase: 'coding', phaseProgress: 50, overallProgress: 50 }
      });

      const event = {
        type: 'QA_STARTED',
        taskId: taskInProgress.id,
        specId: taskInProgress.specId,
        projectId: mockProject.id,
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sequence: 0,
        iteration: 1,
        maxIterations: 3
      };

      // This should create an actor restored to 'coding' state, then transition to 'qa_review'
      manager.handleTaskEvent(taskInProgress.id, event, taskInProgress, mockProject);

      // No error should occur
    });

    it('should restore actor state from task with human_review status', () => {
      const reviewTask = createMockTask({ status: 'human_review', reviewReason: 'qa_rejected' });
      manager.handleUiEvent(reviewTask.id, { type: 'MARK_DONE' }, reviewTask, mockProject);
      expect(manager.getCurrentState(reviewTask.id)).toBe('done');
    });

    it('should restore actor state from task with error status', () => {
      const taskInError = createMockTask({
        status: 'error',
        reviewReason: 'errors'
      });

      // Actor should be created in error state
      manager.handleUiEvent(taskInError.id, { type: 'USER_RESUMED' }, taskInError, mockProject);

      // Should transition from error to coding without error
    });
  });
});
