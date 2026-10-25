/**
 * "Break into tasks" handlers
 *
 * One model call (see task-breakdown.ts) turns a big prompt into dependent task proposals.
 * It can take minutes on local models, so the renderer names each request and can cancel it.
 * The prompt is stored as a proposal when the run starts and replaced by the result (or the failure),
 * so nothing is lost when the dialog is closed or the app restarts. Proposals live in the Queue
 * updates panel (queue-proposals.json) until the tickets are created or the proposal is dismissed.
 */
import { randomUUID } from 'crypto';
import { handleIpc, onIpc } from '../ipc-registry';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { TaskBreakdown } from '../../../shared/types/task-breakdown';
import { projectStore } from '../../project-store';
import { appLog } from '../../app-logger';
import { breakDownTask } from '../../task-breakdown';
import { addBreakdownProposal, dismissQueueProposal } from '../../queue-grooming';
import { newSpecBatchId, specSourcesOf } from '../../spec-batches';
import { listOpenTickets } from '../../../shared/utils/open-tickets';

const running = new Map<string, AbortController>();

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : []);

export function registerTaskBreakdownHandlers(): void {
  handleIpc(
    IPC_CHANNELS.TASK_BREAKDOWN,
    async (event, projectId: string, requestId: string, description: string, attachmentNames?: string[]): Promise<IPCResult<TaskBreakdown>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      if (typeof description !== 'string' || !description.trim()) return { success: false, error: 'Description is empty' };

      const controller = new AbortController();
      running.set(requestId, controller);
      const names = strings(attachmentNames);
      const proposalId = randomUUID();
      const createdAt = new Date().toISOString();
      // Keep the prompt before the (long) model call, so a restart does not lose it
      await addBreakdownProposal(projectId, { id: proposalId, kind: 'breakdownRunning', createdAt, prompt: description, attachmentNames: names });
      try {
        const data = await breakDownTask({
          projectPath: project.path,
          description,
          attachmentNames: names.length > 0 ? names : undefined,
          openTickets: listOpenTickets(projectStore.getTasks(projectId)),
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.TASK_BREAKDOWN_PROGRESS, requestId, progress);
          },
          abortSignal: controller.signal,
        });
        // The tickets made from this breakdown form a spec batch (Spec review loop)
        const result = { ...data, batchId: newSpecBatchId(), specSources: specSourcesOf(description) };
        await addBreakdownProposal(projectId, {
          id: proposalId,
          kind: 'breakdown',
          createdAt,
          prompt: description,
          attachmentNames: names,
          breakdown: result,
        });
        return { success: true, data: { ...result, proposalId } };
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          await dismissQueueProposal(projectId, proposalId);
          return { success: false, error: 'cancelled' };
        }
        const message = error instanceof Error ? error.message : String(error);
        appLog.warn(`[TASK_BREAKDOWN] Failed: ${message}`);
        await addBreakdownProposal(projectId, { id: proposalId, kind: 'breakdownFailed', createdAt, prompt: description, error: message });
        return { success: false, error: message };
      } finally {
        running.delete(requestId);
      }
    }
  );

  onIpc(IPC_CHANNELS.TASK_BREAKDOWN_CANCEL, (_, requestId: string) => {
    running.get(requestId)?.abort();
  });

  // A breakdown under review that the user keeps for later (with the edits made in the dialog); it
  // replaces the stored result when `proposalId` is given
  handleIpc(
    IPC_CHANNELS.TASK_BREAKDOWN_SAVE,
    async (_, projectId: string, prompt: string, attachmentNames: string[], breakdown: TaskBreakdown, proposalId?: string): Promise<IPCResult> => {
      if (!projectStore.getProject(projectId)) return { success: false, error: 'Project not found' };
      if (!breakdown || !Array.isArray(breakdown.tasks) || breakdown.tasks.length === 0) return { success: false, error: 'Nothing to save' };
      return addBreakdownProposal(projectId, {
        id: typeof proposalId === 'string' && proposalId ? proposalId : randomUUID(),
        kind: 'breakdown',
        createdAt: new Date().toISOString(),
        prompt: typeof prompt === 'string' ? prompt : '',
        attachmentNames: strings(attachmentNames),
        breakdown,
      });
    }
  );
}
