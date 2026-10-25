/**
 * Mock implementation for workspace management operations
 */

export const workspaceMock = {
  getWorktreeStatus: async () => ({
    success: true,
    data: {
      exists: false
    }
  }),

  getTaskChangeSummary: async () => ({ success: true, data: null }),

  mergeWorktree: async () => ({
    success: true,
    data: {
      success: true,
      message: 'Merge completed successfully'
    }
  }),

  mergeWorktreePreview: async () => ({
    success: true,
    data: {
      success: true,
      message: 'Preview generated',
      preview: {
        files: ['src/index.ts', 'src/utils.ts'],
        conflicts: [
          {
            file: 'src/utils.ts',
            location: 'lines 10-15',
            tasks: ['task-001'],
            severity: 'low' as const,
            canAutoMerge: true,
            strategy: 'append',
            reason: 'Non-overlapping additions'
          }
        ],
        summary: {
          totalFiles: 2,
          conflictFiles: 1,
          totalConflicts: 1,
          autoMergeable: 1
        }
      }
    }
  }),

  createWorktreePR: async () => ({
    success: true,
    data: {
      success: true,
      prUrl: 'https://github.com/example/repo/pull/123'
    }
  }),

  mergeWorktreePR: async () => ({
    success: true,
    data: { success: true, targetBranch: 'main', conflictedFiles: [] }
  }),

  mergeWorktreeLocal: async () => ({
    success: true,
    data: { success: true, sourceBranch: 'workbench/001-task', targetBranch: 'main' }
  }),

  getWorktreePRState: async () => ({ success: true, data: 'open' as const }),

  discardWorktree: async (_taskId: string, _skipStatusChange?: boolean) => ({
    success: true,
    data: {
      success: true,
      message: 'Worktree discarded successfully'
    }
  }),

  clearStagedState: async () => ({
    success: true,
    data: { cleared: true }
  }),

  listWorktrees: async () => ({
    success: true,
    data: {
      worktrees: []
    }
  })
};
