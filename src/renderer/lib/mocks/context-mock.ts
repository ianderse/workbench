/**
 * Mock implementation for context and memory operations
 */

export const contextMock = {
  getProjectContext: async () => ({
    success: true,
    data: {
      projectIndex: null,
      memoryStatus: null,
      memoryState: null,
      isLoading: false
    }
  }),

  refreshProjectIndex: async () => ({
    success: false,
    error: 'Not available in browser mock'
  }),

  getMemoryStatus: async () => ({
    success: true,
    data: {
      enabled: false,
      available: false,
      reason: 'Browser mock environment'
    }
  })
};
