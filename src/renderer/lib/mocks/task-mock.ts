/**
 * Mock implementation for task operations
 */

import type { TaskRecoveryOptions } from '../../../shared/types';
import { mockTasks } from './mock-data';

export const taskMock = {
  getTasks: async (projectId: string) => ({
    success: true,
    data: mockTasks.filter(t => t.projectId === projectId)
  }),

  createTask: async (projectId: string, title: string, description: string) => ({
    success: true,
    data: {
      id: `task-${Date.now()}`,
      projectId,
      specId: `00${mockTasks.length + 1}-new-task`,
      title,
      description,
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  deleteTask: async () => ({ success: true }),

  updateTask: async (_taskId: string, updates: { title?: string; description?: string }) => ({
    success: true,
    data: {
      id: _taskId,
      projectId: 'mock-project-1',
      specId: '001-updated',
      title: updates.title || 'Updated Task',
      description: updates.description || 'Updated description',
      status: 'backlog' as const,
      subtasks: [],
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  }),

  startTask: () => {
    console.warn('[Browser Mock] startTask called');
  },

  stopTask: () => {
    console.warn('[Browser Mock] stopTask called');
  },

  retryTask: async () => ({ success: true, data: { action: 'started' as const } }),

  submitReview: async () => ({ success: true }),

  // Task archive operations
  archiveTasks: async () => ({ success: true, data: true }),
  unarchiveTasks: async () => ({ success: true, data: true }),

  // Task status operations
  updateTaskStatus: async (_taskId: string, _status: string, _options?: { forceCleanup?: boolean }) => ({ success: true }),

  recoverStuckTask: async (taskId: string, options?: TaskRecoveryOptions) => ({
    success: true,
    data: {
      taskId,
      recovered: true,
      newStatus: options?.targetStatus || 'backlog',
      message: '[Browser Mock] Task recovered successfully'
    }
  }),

  checkTaskRunning: async () => ({ success: true, data: false }),


  // Worktree change detection
  checkWorktreeChanges: async (_taskId: string) => ({
    success: true as const,
    data: { hasChanges: false }
  }),

  // Image operations
  loadImageThumbnail: async (_projectPath: string, _specId: string, _imagePath: string) => ({
    success: false,
    error: 'Image loading not available in browser mode'
  }),

  // Task logs operations
  getTaskLogs: async () => ({
    success: true,
    data: null
  }),

  getPreviousTaskRuns: async () => ({
    success: true,
    data: []
  }),

  watchTaskLogs: async () => ({ success: true }),

  unwatchTaskLogs: async () => ({ success: true }),

  // Event Listeners (no-op in browser)
  onTaskProgress: () => () => {},
  onTaskError: () => () => {},
  onTaskLog: () => () => {},
  onTaskStatusChange: () => () => {},
  onTaskRateLimitHoldChange: () => () => {},
  onTaskClaudeRunUpdate: () => () => {},
  setQueueOrder: () => {},

  breakDownTask: async () => ({
    success: true,
    data: {
      tasks: [
        { key: 't1', title: 'Set up the data model', description: 'Add the schema and migrations', dependsOn: [] },
        { key: 't2', title: 'Build the API', description: 'Expose the data model over the API', dependsOn: ['t1'] },
        { key: 't3', title: 'Build the UI', description: 'Add the screens that use the API', dependsOn: ['t2'] },
      ],
    },
  }),
  cancelBreakDownTask: () => {},
  registerSpecBatch: async () => ({ success: true }),
  onBreakDownProgress: () => () => {},
  onTaskExecutionProgress: () => () => {},
  onTaskLogsChanged: () => () => {},
  onTaskLogsStream: () => () => {},
  onMergeProgress: () => () => {},
  onMergePRProgress: () => () => {},
  onTaskListChanged: () => () => {}
};
