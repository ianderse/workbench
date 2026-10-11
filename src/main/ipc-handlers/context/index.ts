import type { BrowserWindow } from 'electron';
import { registerProjectContextHandlers } from './project-context-handlers';

/**
 * Register all context-related IPC handlers
 */
export function registerContextHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  registerProjectContextHandlers(getMainWindow);
}

export * from './project-context-handlers';
