/**
 * Self-improve API for the renderer: the project's memory index, built from its past sessions
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { SelfImproveIndexInfo } from '../../../shared/types/cli';
import { invokeIpc } from './ipc-utils';

export interface SelfImproveAPI {
  /** The project's memory index stats, or null when it has never been built */
  getMemoryIndex: (projectId: string) => Promise<IPCResult<SelfImproveIndexInfo | null>>;
  /** Build (or rebuild) the project's memories from its past Claude Code sessions */
  buildMemoryIndex: (projectId: string) => Promise<IPCResult<SelfImproveIndexInfo>>;
  /** Whether a memory index build is running for the project */
  isMemoryIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
}

export const createSelfImproveAPI = (): SelfImproveAPI => ({
  getMemoryIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_IMPROVE_GET_INDEX, projectId),
  buildMemoryIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_IMPROVE_BUILD_INDEX, projectId),
  isMemoryIndexBuilding: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_IMPROVE_IS_BUILDING, projectId),
});
