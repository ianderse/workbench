/**
 * Mock implementation for project context operations
 */

export const contextMock = {
  getProjectContext: async () => ({
    success: true,
    data: {
      projectIndex: null,
      isLoading: false
    }
  }),

  refreshProjectIndex: async () => ({
    success: false,
    error: 'Not available in browser mock'
  })
};
