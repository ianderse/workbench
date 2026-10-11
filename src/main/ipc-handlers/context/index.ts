import type { BrowserWindow } from 'electron';
import { registerProjectContextHandlers } from './project-context-handlers';
import { registerMemoryStatusHandlers } from './memory-status-handlers';

/**
 * Register all context-related IPC handlers
 */
export function registerContextHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  registerProjectContextHandlers(getMainWindow);
  registerMemoryStatusHandlers(getMainWindow);
}

// Re-export utility functions for testing or external use
export * from './utils';
export * from './memory-status-handlers';
export * from './project-context-handlers';
export * from './memory-service-factory';
