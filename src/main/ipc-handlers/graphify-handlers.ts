/**
 * Graphify IPC handlers: CLI version check and install (Settings > Updates), and each project's memory graph (Settings > Project > Knowledge index)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { GraphifyGraph, GraphifyIndexInfo, GraphifyVersionInfo } from '../../shared/types/cli';
import { projectStore } from '../project-store';
import { appLog } from '../app-logger';
import {
  buildGraphifyIndex,
  checkGraphifyVersion,
  detectGraphify,
  getGraphifyInstallCommand,
  hasGraphifyGraph,
  isGraphifyEnabled,
  readGraphifyGraph,
  setGraphifyEnabled,
  readGraphifyIndex,
  setUpClaudeCommandAfterInstall,
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

  // Open a terminal with the install (or update) command; once the new graphify command shows up,
  // /graphify is added to Claude Code
  ipcMain.handle(IPC_CHANNELS.GRAPHIFY_INSTALL, async (): Promise<IPCResult<{ command: string }>> => {
    try {
      const installation = await detectGraphify();
      const command = await getGraphifyInstallCommand(!!installation);
      await openTerminalWithCommand(command);
      setUpClaudeCommandAfterInstall(installation ? installation.version : null);
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
    IPC_CHANNELS.GRAPHIFY_HAS_GRAPH,
    async (_event, projectId: string): Promise<IPCResult<boolean>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      return { success: true, data: await hasGraphifyGraph(project.path) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GRAPHIFY_IS_ENABLED,
    async (_event, projectId: string): Promise<IPCResult<boolean>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      return { success: true, data: await isGraphifyEnabled(project.path) };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GRAPHIFY_SET_ENABLED,
    async (_event, projectId: string, enabled: boolean): Promise<IPCResult> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        await setGraphifyEnabled(project.path, enabled);
        return { success: true };
      } catch (error) {
        appLog.error('[Graphify] Switching Use Graphify failed:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GRAPHIFY_GET_GRAPH,
    async (_event, projectId: string): Promise<IPCResult<GraphifyGraph | null>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      try {
        return { success: true, data: await readGraphifyGraph(project.path) };
      } catch (error) {
        appLog.error('[Graphify] Reading the memory graph failed:', error);
        return { success: false, error: errorMessage(error) };
      }
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
