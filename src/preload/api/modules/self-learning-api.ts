/**
 * Self-learning API for the renderer: the project's memory index, built from its past sessions
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { SelfLearningIndexInfo } from '../../../shared/types/cli';
import { invokeIpc } from './ipc-utils';

export interface SelfLearningAPI {
  /** The project's memory index stats, or null when it has never been built */
  getMemoryIndex: (projectId: string) => Promise<IPCResult<SelfLearningIndexInfo | null>>;
  /** Build (or rebuild) the project's memories from its past Claude Code sessions */
  buildMemoryIndex: (projectId: string) => Promise<IPCResult<SelfLearningIndexInfo>>;
  /** Whether a memory index build is running for the project */
  isMemoryIndexBuilding: (projectId: string) => Promise<IPCResult<boolean>>;
}

export const createSelfLearningAPI = (): SelfLearningAPI => ({
  getMemoryIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_LEARNING_GET_INDEX, projectId),
  buildMemoryIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_LEARNING_BUILD_INDEX, projectId),
  isMemoryIndexBuilding: (projectId: string) => invokeIpc(IPC_CHANNELS.SELF_LEARNING_IS_BUILDING, projectId),
});
