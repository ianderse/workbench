/**
 * Autonomous mode IPC handlers: the hook that merges a task once it passed AI review, the
 * integration branch banner, revert, and undo of the queue changes grooming applied on its own.
 */
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type {
  AutonomousMergeIntoBaseResult,
  AutonomousRevertPreview,
  AutonomousRevertResult,
  AutonomousStatus,
} from '../../shared/types/autonomous';
import type { QueueUndoEntry } from '../../shared/types/queue-grooming';
import { handleIpc } from './ipc-registry';
import { safeSendToRenderer } from './utils';
import { findTaskAndProject } from './task/shared';
import { taskHooks } from '../task-hooks';
import { appLog } from '../app-logger';
import { readQueueProposals, undoQueueChange } from '../queue-grooming';
import { projectStore } from '../project-store';
import {
  clearAutoMergeBlocked,
  configureAutonomous,
  getAutonomousStatus,
  maybeAutoMerge,
  mergeIntegrationIntoMain,
  previewRevert,
  revertAutoMerge,
} from '../autonomous/autonomous-service';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function registerAutonomousHandlers(getMainWindow: () => BrowserWindow | null): void {
  configureAutonomous((projectId) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.AUTONOMOUS_CHANGED, projectId);
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LIST_CHANGED, projectId);
  });

  // A task that enters Human Review after its run may be merged on its own; a task that runs
  // again forgets that its last merge was blocked
  taskHooks.on('state', ({ project, task, status }) => {
    if (status === 'human_review') {
      void maybeAutoMerge(project, task).catch((error) => appLog.warn('[Autonomous] Auto-merge failed:', error));
    } else if (status === 'in_progress' || status === 'ai_review') {
      clearAutoMergeBlocked(project, task);
    }
  });

  handleIpc(IPC_CHANNELS.AUTONOMOUS_STATUS, async (_, projectId: string): Promise<IPCResult<AutonomousStatus | null>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: await getAutonomousStatus(project) };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  handleIpc(IPC_CHANNELS.AUTONOMOUS_MERGE_INTO_BASE, async (_, projectId: string): Promise<IPCResult<AutonomousMergeIntoBaseResult>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return await mergeIntegrationIntoMain(project);
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  handleIpc(IPC_CHANNELS.AUTONOMOUS_REVERT_PREVIEW, async (_, taskId: string, projectId: string): Promise<IPCResult<AutonomousRevertPreview>> => {
    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return { success: false, error: 'Task not found' };
    return { success: true, data: previewRevert(project, task) };
  });

  handleIpc(IPC_CHANNELS.AUTONOMOUS_REVERT, async (_, taskId: string, projectId: string): Promise<IPCResult<AutonomousRevertResult>> => {
    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return { success: false, error: 'Task not found' };
    try {
      return await revertAutoMerge(project, task);
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  handleIpc(IPC_CHANNELS.QUEUE_UNDO_LIST, async (_, projectId: string): Promise<IPCResult<QueueUndoEntry[]>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: (await readQueueProposals(project)).undo };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  handleIpc(IPC_CHANNELS.QUEUE_CHANGE_UNDO, async (_, projectId: string, undoId: string): Promise<IPCResult> => {
    const result = await undoQueueChange(projectId, undoId);
    return result.success ? { success: true } : { success: false, error: result.error };
  });
}
