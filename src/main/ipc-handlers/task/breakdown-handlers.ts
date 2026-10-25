/**
 * "Break into tasks" handlers
 *
 * One model call (see task-breakdown.ts) turns a big prompt into dependent task proposals.
 * It can take minutes on local models, so the renderer names each request and can cancel it.
 * When the dialog is closed meanwhile ("Keep working in the background"), the run continues and
 * its result is kept as a proposal in the Queue updates panel (queue-proposals.json).
 */
import { randomUUID } from 'crypto';
import { handleIpc, onIpc } from '../ipc-registry';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { TaskBreakdown } from '../../../shared/types/task-breakdown';
import { projectStore } from '../../project-store';
import { appLog } from '../../app-logger';
import { breakDownTask } from '../../task-breakdown';
import { addBreakdownProposal } from '../../queue-grooming';
import { newSpecBatchId, specSourcesOf } from '../../spec-batches';
import { listOpenTickets } from '../../../shared/utils/open-tickets';

interface RunningBreakdown {
  controller: AbortController;
  /** The dialog was closed: keep the result as a proposal */
  background: boolean;
}

const running = new Map<string, RunningBreakdown>();

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : []);

export function registerTaskBreakdownHandlers(): void {
  handleIpc(
    IPC_CHANNELS.TASK_BREAKDOWN,
    async (event, projectId: string, requestId: string, description: string, attachmentNames?: string[]): Promise<IPCResult<TaskBreakdown>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      if (typeof description !== 'string' || !description.trim()) return { success: false, error: 'Description is empty' };

      const entry: RunningBreakdown = { controller: new AbortController(), background: false };
      running.set(requestId, entry);
      const names = strings(attachmentNames);
      try {
        const data = await breakDownTask({
          projectPath: project.path,
          description,
          attachmentNames: names.length > 0 ? names : undefined,
          openTickets: listOpenTickets(projectStore.getTasks(projectId)),
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.TASK_BREAKDOWN_PROGRESS, requestId, progress);
          },
          abortSignal: entry.controller.signal,
        });
        // The tickets made from this breakdown form a spec batch (Spec review loop)
        const result = { ...data, batchId: newSpecBatchId(), specSources: specSourcesOf(description) };
        if (entry.background) {
          await addBreakdownProposal(projectId, {
            id: randomUUID(),
            kind: 'breakdown',
            createdAt: new Date().toISOString(),
            prompt: description,
            attachmentNames: names,
            breakdown: result,
          });
        }
        return { success: true, data: result };
      } catch (error) {
        if (entry.controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return { success: false, error: 'cancelled' };
        }
        const message = error instanceof Error ? error.message : String(error);
        appLog.warn(`[TASK_BREAKDOWN] Failed: ${message}`);
        if (entry.background) {
          await addBreakdownProposal(projectId, {
            id: randomUUID(),
            kind: 'breakdownFailed',
            createdAt: new Date().toISOString(),
            prompt: description,
            error: message,
          });
        }
        return { success: false, error: message };
      } finally {
        running.delete(requestId);
      }
    }
  );

  onIpc(IPC_CHANNELS.TASK_BREAKDOWN_CANCEL, (_, requestId: string) => {
    running.get(requestId)?.controller.abort();
  });

  // The dialog was closed with "Keep working in the background"
  onIpc(IPC_CHANNELS.TASK_BREAKDOWN_BACKGROUND, (_, requestId: string) => {
    const entry = running.get(requestId);
    if (entry) entry.background = true;
  });

  // A breakdown under review that the user keeps for later
  handleIpc(
    IPC_CHANNELS.TASK_BREAKDOWN_SAVE,
    async (_, projectId: string, prompt: string, attachmentNames: string[], breakdown: TaskBreakdown): Promise<IPCResult> => {
      if (!projectStore.getProject(projectId)) return { success: false, error: 'Project not found' };
      if (!breakdown || !Array.isArray(breakdown.tasks) || breakdown.tasks.length === 0) return { success: false, error: 'Nothing to save' };
      return addBreakdownProposal(projectId, {
        id: randomUUID(),
        kind: 'breakdown',
        createdAt: new Date().toISOString(),
        prompt: typeof prompt === 'string' ? prompt : '',
        attachmentNames: strings(attachmentNames),
        breakdown,
      });
    }
  );
}
