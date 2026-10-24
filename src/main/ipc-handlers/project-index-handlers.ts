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
import { buildProjectIndex, isProjectIndexBuilding, readProjectIndexInfo, stashProjectIndex } from '../project-index';

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
    async (_event, projectId: string, restore?: boolean): Promise<IPCResult<ProjectIndexInfo>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        // The project's own Claude account when it has one, so the run bills where its work does.
        // `restore` comes from switching the index on, the one request that means "give the project
        // the CLAUDE.md it had"; the Rebuild button asks for a fresh read of the codebase
        return {
          success: true,
          data: await buildProjectIndex(project.path, project.settings.claudeProfileId, { restore }),
        };
      } catch (error) {
        appLog.error('[ProjectIndex] Writing CLAUDE.md failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  // Switching the index off: the project's CLAUDE.md is moved aside rather than removed, so
  // switching back on hands the user their own file back instead of writing a fresh one
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_INDEX_STASH,
    async (_event, projectId: string): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        await stashProjectIndex(project.path);
        return { success: true };
      } catch (error) {
        appLog.error('[ProjectIndex] Setting CLAUDE.md aside failed:', error);
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
