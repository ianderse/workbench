/**
 * Graphify IPC handlers: CLI version check and install (Settings > Updates) and each project's
 * memory graph (Settings > Project > Memory index)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { GraphifyIndexInfo, GraphifyVersionInfo } from '../../shared/types/cli';
import { projectStore } from '../project-store';
import { appLog } from '../app-logger';
import {
  buildGraphifyIndex,
  checkGraphifyVersion,
  detectGraphify,
  getGraphifyInstallCommand,
  readGraphifyIndex,
} from '../graphify';
import { openTerminalWithCommand } from './claude-code-handlers';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerGraphifyHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.GRAPHIFY_CHECK_VERSION,
    async (_event, forceRefresh?: boolean): Promise<IPCResult<GraphifyVersionInfo>> => {
      try {
        return { success: true, data: await checkGraphifyVersion(forceRefresh === true) };
      } catch (error) {
        appLog.error('[Graphify] Version check failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  // Open a terminal with the install (or update) command
  ipcMain.handle(IPC_CHANNELS.GRAPHIFY_INSTALL, async (): Promise<IPCResult<{ command: string }>> => {
    try {
      const command = await getGraphifyInstallCommand(!!(await detectGraphify()));
      await openTerminalWithCommand(command);
      return { success: true, data: { command } };
    } catch (error) {
      appLog.error('[Graphify] Install failed:', error);
      return { success: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.GRAPHIFY_GET_INDEX,
    async (_event, projectId: string): Promise<IPCResult<GraphifyIndexInfo | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      return { success: true, data: await readGraphifyIndex(project.path) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GRAPHIFY_BUILD_INDEX,
    async (_event, projectId: string): Promise<IPCResult<GraphifyIndexInfo>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        return { success: true, data: await buildGraphifyIndex(project.path) };
      } catch (error) {
        appLog.error('[Graphify] Building the memory graph failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );
}
