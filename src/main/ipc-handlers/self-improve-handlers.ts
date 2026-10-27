/**
 * Self-improve IPC handlers: the project's memory index (Settings > Project > Knowledge), built
 * from the Claude Code sessions the project already had.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { SelfImproveIndexInfo } from '../../shared/types/cli';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { buildMemoryIndex, isMemoryIndexBuilding, readMemoryIndexInfo } from '../self-improve/backfill';
import path from 'path';
import { open, realpath } from 'fs/promises';
import { getSpecsDir } from '../../shared/constants';
import { getCompengDir } from '../self-improve/paths';
import { listProjectMemories, mutateProjectMemory, readMemoryContexts, validateMemoryContent } from '../self-improve/project-memory';
import type { MemoryMutation, MemorySource } from '../../shared/types/project-memory';
import { startMemoryAutomation } from '../self-improve/memory-service';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerSelfImproveHandlers(getMainWindow: () => BrowserWindow | null = () => null): void {
  startMemoryAutomation(getMainWindow);
  const memoryProject = (projectId: string) => {
    const project = projectStore.getProject(projectId);
    if (!project) throw new Error('Project not found');
    return project;
  };
  // Managed records stay in place when the switch is off, and remain viewable.
  const memoryDir = (project: ReturnType<typeof memoryProject>) => getCompengDir(project.path);
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_LIST, async (_event, projectId: string) => {
    try { const project = memoryProject(projectId); return { success: true, data: await listProjectMemories(memoryDir(project), projectId) }; }
    catch (error) { return { success: false, error: errorMessage(error) }; }
  });
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_MUTATE, async (_event, projectId: string, mutation: MemoryMutation) => {
    try {
      const project = memoryProject(projectId);
      if (!project.settings.selfImprove) throw new Error('Enable project memory before changing entries');
      if (!mutation || typeof mutation !== 'object') throw new Error('Invalid memory mutation');
      if (mutation.action === 'propose' || mutation.action === 'revise') {
        const content = validateMemoryContent(mutation.content);
        if (content.source.type === 'task' && !projectStore.getTasks(projectId).some((task) => task.specId === content.source.reference)) throw new Error('Source task is not in this project');
      }
      return { success: true, data: await mutateProjectMemory(memoryDir(project), projectId, mutation) };
    } catch (error) { return { success: false, error: errorMessage(error) }; }
  });
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_CONTEXT, async (_event, projectId: string, taskId: string) => {
    try {
      const project = memoryProject(projectId);
      const task = projectStore.getTasks(projectId).find((item) => item.id === taskId || item.specId === taskId);
      if (!task) throw new Error('Task not found in project');
      return { success: true, data: await readMemoryContexts(path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId), projectId, task.specId) };
    } catch (error) { return { success: false, error: errorMessage(error) }; }
  });
  ipcMain.handle(IPC_CHANNELS.PROJECT_MEMORY_SOURCE, async (_event, projectId: string, source: MemorySource) => {
    try {
      const project = memoryProject(projectId);
      validateMemoryContent({ kind: 'lesson', title: 'Source', body: 'Source', source });
      let text = source.evidence;
      if (source.type === 'task') {
        const task = projectStore.getTasks(projectId).find((item) => item.specId === source.reference);
        if (!task) throw new Error('Source task no longer exists');
        text = `${task.specId}: ${task.title}\n\n${task.description}\n\n${source.evidence}`;
      } else if (source.type === 'file') {
        const root = await realpath(project.path);
        const file = await realpath(path.resolve(root, source.reference.replace(/:\d+$/, '')));
        const relative = path.relative(root, file);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Source is outside project');
        const handle = await open(file, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Source is not a regular file');
          const buffer = Buffer.alloc(16_000);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
      }
      return { success: true, data: text.slice(0, 16_000) };
    } catch (error) { return { success: false, error: errorMessage(error) }; }
  });
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
