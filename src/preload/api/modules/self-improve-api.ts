/**
 * Self-improve API for the renderer: the project's memory index, built from its past sessions
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { SelfImproveIndexInfo } from '../../../shared/types/cli';
import { createIpcListener, invokeIpc } from './ipc-utils';
import type { MemoryContextPacket, MemoryMutation, MemorySource, ProjectMemory } from '../../../shared/types/project-memory';

export interface SelfImproveAPI {
  onProjectMemoryChanged: (callback: (projectId: string) => void) => () => void;
  listProjectMemories: (projectId: string) => Promise<IPCResult<ProjectMemory[]>>;
  mutateProjectMemory: (projectId: string, mutation: MemoryMutation) => Promise<IPCResult<ProjectMemory>>;
  getTaskMemoryContext: (projectId: string, taskId: string) => Promise<IPCResult<MemoryContextPacket[]>>;
  readMemorySource: (projectId: string, source: MemorySource) => Promise<IPCResult<string>>;
  /** The project's memory index stats, or null when it has never been built */
  getMemoryIndex: (projectId: string) => Promise<IPCResult<SelfImproveIndexInfo | null>>;
  /** Build (or rebuild) the project's memories from its past Claude Code sessions */
  buildMemoryIndex: (projectId: string) => Promise<IPCResult<SelfImproveIndexInfo>>;
  /** Whether a memory index build is running for the project */
  isMemoryIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
}

export const createSelfImproveAPI = (): SelfImproveAPI => ({
  onProjectMemoryChanged: (callback) => createIpcListener(IPC_CHANNELS.PROJECT_MEMORY_CHANGED, callback),
  listProjectMemories: (projectId) => invokeIpc(IPC_CHANNELS.PROJECT_MEMORY_LIST, projectId),
  mutateProjectMemory: (projectId, mutation) => invokeIpc(IPC_CHANNELS.PROJECT_MEMORY_MUTATE, projectId, mutation),
  getTaskMemoryContext: (projectId, taskId) => invokeIpc(IPC_CHANNELS.PROJECT_MEMORY_CONTEXT, projectId, taskId),
  readMemorySource: (projectId, source) => invokeIpc(IPC_CHANNELS.PROJECT_MEMORY_SOURCE, projectId, source),
  getMemoryIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_IMPROVE_GET_INDEX, projectId),
  buildMemoryIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_IMPROVE_BUILD_INDEX, projectId),
  isMemoryIndexBuilding: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_IMPROVE_IS_BUILDING, projectId),
});
