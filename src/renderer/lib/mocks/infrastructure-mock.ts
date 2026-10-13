/**
 * Mock implementation for shell operations
 */

export const infrastructureMock = {
  // Shell Operations
  openExternal: async (url: string) => {
    console.warn('[Browser Mock] openExternal:', url);
    window.open(url, '_blank');
  },

  openTerminal: async (dirPath: string) => {
    console.warn('[Browser Mock] openTerminal:', dirPath);
    return { success: true };
  }
};
