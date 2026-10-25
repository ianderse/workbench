/**
 * Spec review loop IPC handlers: the batch a Break into tasks run created, and the hooks that
 * create a batch's Spec review ticket when its tickets are finished and apply the review's result
 * (see spec-batches.ts).
 */
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import { handleIpc } from './ipc-registry';
import { safeSendToRenderer } from './utils';
import { taskHooks } from '../task-hooks';
import { taskQueue } from '../services/task-queue';
import { appLog } from '../app-logger';
import {
  applySpecReview,
  configureSpecBatches,
  evaluateAllSpecBatches,
  evaluateSpecBatch,
  registerSpecBatch,
  type RegisterSpecBatchInput,
} from '../spec-batches';

export function registerSpecReviewHandlers(getMainWindow: () => BrowserWindow | null): void {
  configureSpecBatches((projectId) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LIST_CHANGED, projectId);
    // New tickets were queued
    taskQueue.request(projectId);
  });

  taskHooks.on('state', ({ project, task, status }) => {
    const review = task.metadata?.specReview;
    if (review) {
      if (status === 'human_review') void applySpecReview(project.id, task.id);
      return;
    }
    const batch = task.metadata?.specBatch;
    if (batch) void evaluateSpecBatch(project.id, batch.id);
  });

  taskHooks.on('merged', ({ project, task }) => {
    const batch = task.metadata?.specBatch;
    if (batch) void evaluateSpecBatch(project.id, batch.id);
  });

  // Batches that changed while the app was closed
  setTimeout(() => {
    void evaluateAllSpecBatches().catch((error) => appLog.warn('[SpecReview] Startup check failed:', error));
  }, 15_000);

  handleIpc(IPC_CHANNELS.SPEC_BATCH_REGISTER, async (_, projectId: string, input: RegisterSpecBatchInput): Promise<IPCResult> => {
    try {
      if (!input || typeof input.id !== 'string' || !Array.isArray(input.taskIds)) return { success: false, error: 'Invalid batch' };
      await registerSpecBatch(projectId, {
        id: input.id,
        prompt: typeof input.prompt === 'string' ? input.prompt : '',
        sources: Array.isArray(input.sources) ? input.sources.filter((s) => typeof s === 'string') : undefined,
        taskIds: input.taskIds.filter((id) => typeof id === 'string'),
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
