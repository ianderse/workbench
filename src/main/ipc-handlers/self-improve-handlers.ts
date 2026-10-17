/**
 * Self-improve IPC handlers: the project's memory index (Settings > Project > Knowledge), built
 * from the Claude Code sessions the project already had.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { SelfImproveIndexInfo } from '../../shared/types/cli';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { buildMemoryIndex, isMemoryIndexBuilding, readMemoryIndexInfo } from '../self-improve/backfill';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerSelfImproveHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.SELF_IMPROVE_GET_INDEX,
    async (_event, projectId: string): Promise<IPCResult<SelfImproveIndexInfo | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        return { success: true, data: await readMemoryIndexInfo(project.path) };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SELF_IMPROVE_BUILD_INDEX,
    async (_event, projectId: string): Promise<IPCResult<SelfImproveIndexInfo>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        // The project's own Claude account when it has one, so the scan bills where its work does
        return { success: true, data: await buildMemoryIndex(project.path, project.settings.claudeProfileId) };
      } catch (error) {
        appLog.error('[IPC] SELF_IMPROVE_BUILD_INDEX failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SELF_IMPROVE_IS_BUILDING,
    async (_event, projectId: string): Promise<IPCResult<boolean>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      return { success: true, data: isMemoryIndexBuilding(project.path) };
    }
  );
}
