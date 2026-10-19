/**
 * Project index IPC handlers: the project's CLAUDE.md (Settings > Project), written by a short
 * Claude Code run of `/init`.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { ProjectIndexInfo } from '../../shared/types/cli';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { buildProjectIndex, deleteProjectIndex, isProjectIndexBuilding, readProjectIndexInfo } from '../project-index';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerProjectIndexHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INDEX_GET,
    async (_event, projectId: string): Promise<IPCResult<ProjectIndexInfo | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        return { success: true, data: await readProjectIndexInfo(project.path) };
      } catch (error) {
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INDEX_BUILD,
    async (_event, projectId: string): Promise<IPCResult<ProjectIndexInfo>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        // The project's own Claude account when it has one, so the run bills where its work does
        return { success: true, data: await buildProjectIndex(project.path, project.settings.claudeProfileId) };
      } catch (error) {
        appLog.error('[ProjectIndex] Writing CLAUDE.md failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INDEX_DELETE,
    async (_event, projectId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        await deleteProjectIndex(project.path);
        return { success: true };
      } catch (error) {
        appLog.error('[ProjectIndex] Removing CLAUDE.md failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INDEX_IS_BUILDING,
    async (_event, projectId: string): Promise<IPCResult<boolean>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      return { success: true, data: isProjectIndexBuilding(project.path) };
    }
  );
}
