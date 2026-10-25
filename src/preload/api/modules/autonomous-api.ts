/** Autonomous mode API for the renderer: the integration branch banner, revert, undo of automatic queue changes */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type {
  AutonomousMergeIntoBaseResult,
  AutonomousRevertPreview,
  AutonomousRevertResult,
  AutonomousStatus,
} from '../../../shared/types/autonomous';
import type { QueueUndoEntry } from '../../../shared/types/queue-grooming';
import { createIpcListener, invokeIpc } from './ipc-utils';

export interface AutonomousAPI {
  /** The target branch and how far the integration branch is ahead of the base branch (null while the mode is off) */
  getAutonomousStatus: (projectId: string) => Promise<IPCResult<AutonomousStatus | null>>;
  mergeIntegrationIntoBase: (projectId: string) => Promise<IPCResult<AutonomousMergeIntoBaseResult>>;
  previewAutoMergeRevert: (taskId: string, projectId: string) => Promise<IPCResult<AutonomousRevertPreview>>;
  revertAutoMerge: (taskId: string, projectId: string) => Promise<IPCResult<AutonomousRevertResult>>;
  /** Structural queue changes applied without asking, newest last */
  listQueueUndo: (projectId: string) => Promise<IPCResult<QueueUndoEntry[]>>;
  undoQueueChange: (projectId: string, undoId: string) => Promise<IPCResult>;
  onAutonomousChanged: (callback: (projectId: string) => void) => () => void;
}

export const createAutonomousAPI = (): AutonomousAPI => ({
  getAutonomousStatus: (projectId) => invokeIpc(IPC_CHANNELS.AUTONOMOUS_STATUS, projectId),
  mergeIntegrationIntoBase: (projectId) => invokeIpc(IPC_CHANNELS.AUTONOMOUS_MERGE_INTO_BASE, projectId),
  previewAutoMergeRevert: (taskId, projectId) => invokeIpc(IPC_CHANNELS.AUTONOMOUS_REVERT_PREVIEW, taskId, projectId),
  revertAutoMerge: (taskId, projectId) => invokeIpc(IPC_CHANNELS.AUTONOMOUS_REVERT, taskId, projectId),
  listQueueUndo: (projectId) => invokeIpc(IPC_CHANNELS.QUEUE_UNDO_LIST, projectId),
  undoQueueChange: (projectId, undoId) => invokeIpc(IPC_CHANNELS.QUEUE_CHANGE_UNDO, projectId, undoId),
  onAutonomousChanged: (callback) => createIpcListener(IPC_CHANNELS.AUTONOMOUS_CHANGED, callback),
});
