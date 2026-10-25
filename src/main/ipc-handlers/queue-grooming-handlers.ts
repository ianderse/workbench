/**
 * Queue grooming IPC handlers: the proposals a merged task left for the tickets in Planning and
 * the Queue (see queue-grooming.ts), and the hook that starts a grooming after every merge.
 */
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { QueueProposal } from '../../shared/types/queue-grooming';
import { handleIpc, invokeIpcHandler } from './ipc-registry';
import { projectStore } from '../project-store';
import { safeSendToRenderer } from './utils';
import { taskHooks } from '../task-hooks';
import { taskQueue } from '../services/task-queue';
import { appLog } from '../app-logger';
import { createFollowUpTickets } from '../follow-up-tickets';
import {
  applyQueueProposal,
  configureQueueGrooming,
  dismissQueueProposal,
  groomQueueAfterMerge,
  listQueueProposals,
  undoContextNote,
} from '../queue-grooming';

export function registerQueueGroomingHandlers(getMainWindow: () => BrowserWindow | null): void {
  configureQueueGrooming((projectId) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.QUEUE_PROPOSALS_CHANGED, projectId);
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LIST_CHANGED, projectId);
    // Archived or re-linked tickets may free queued tasks
    taskQueue.request(projectId);
  });

  // Every merge path (local merge, merged pull request, full worktree merge) emits `merged`.
  // Today structural changes only become proposals; an autonomous mode would pass true.
  taskHooks.on('merged', ({ project, task }) => {
    void groomQueueAfterMerge(project.id, task.id, { autoApplyStructural: false }).catch((error) => {
      appLog.warn('[QueueGrooming] Grooming failed:', error);
    });
  });

  // A task that reached Human Review: the work its review summary flags becomes new tickets. This
  // runs in the main process on the state change, not when the panel is opened. It handles each
  // task once and ignores states that are not completed / auto-merged
  taskHooks.on('state', ({ project, task, status }) => {
    if (status !== 'human_review') return;
    void createFollowUpTickets(project.id, task.id);
  });

  handleIpc(IPC_CHANNELS.QUEUE_PROPOSALS_LIST, async (_, projectId: string): Promise<IPCResult<QueueProposal[]>> => {
    try {
      return { success: true, data: await listQueueProposals(projectId) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * A task paused after planning (Human Review, split_proposed) continues once its split is decided:
   * on Apply with the reduced scope, on Dismiss with the whole ticket. Same as pressing Resume.
   */
  const resumeAfterSplitDecision = async (projectId: string, taskId: string): Promise<void> => {
    try {
      const task = projectStore.getTasks(projectId).find((t) => t.id === taskId);
      if (!task || task.status !== 'human_review' || task.reviewReason !== 'split_proposed') return;
      appLog.info(`[TaskSplit] Resuming ${taskId} after the split was decided`);
      await invokeIpcHandler(IPC_CHANNELS.TASK_START, taskId, undefined, projectId);
    } catch (error) {
      appLog.warn(`[TaskSplit] Could not resume ${taskId} after the split was decided:`, error);
    }
  };

  const splitTaskOf = async (projectId: string, proposalId: string): Promise<string | undefined> => {
    const proposal = (await listQueueProposals(projectId)).find((p) => p.id === proposalId);
    return proposal?.kind === 'split' ? proposal.taskId : undefined;
  };

  handleIpc(IPC_CHANNELS.QUEUE_PROPOSAL_APPLY, async (_, projectId: string, proposalId: string): Promise<IPCResult> => {
    const splitTaskId = await splitTaskOf(projectId, proposalId);
    const result = await applyQueueProposal(projectId, proposalId);
    if (result.success && splitTaskId) void resumeAfterSplitDecision(projectId, splitTaskId);
    return result.success ? { success: true } : { success: false, error: result.error };
  });

  handleIpc(IPC_CHANNELS.QUEUE_PROPOSAL_DISMISS, async (_, projectId: string, proposalId: string): Promise<IPCResult> => {
    const splitTaskId = await splitTaskOf(projectId, proposalId);
    const result = await dismissQueueProposal(projectId, proposalId);
    if (result.success && splitTaskId) void resumeAfterSplitDecision(projectId, splitTaskId);
    return result.success ? { success: true } : { success: false, error: result.error };
  });

  handleIpc(IPC_CHANNELS.QUEUE_NOTE_UNDO, async (_, projectId: string, taskId: string, noteId: string): Promise<IPCResult> => {
    const result = await undoContextNote(projectId, taskId, noteId);
    return result.success ? { success: true } : { success: false, error: result.error };
  });
}
