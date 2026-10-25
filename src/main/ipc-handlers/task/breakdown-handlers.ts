/**
 * "Break into tasks" handlers
 *
 * One model call (see task-breakdown.ts) turns a big prompt into dependent task proposals.
 * It can take minutes on a long spec, so the renderer names each request and can cancel it.
 */
import { handleIpc, onIpc } from '../ipc-registry';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { TaskBreakdown } from '../../../shared/types/task-breakdown';
import { projectStore } from '../../project-store';
import { appLog } from '../../app-logger';
import { breakDownTask } from '../../task-breakdown';

const running = new Map<string, AbortController>();

export function registerTaskBreakdownHandlers(): void {
  handleIpc(
    IPC_CHANNELS.TASK_BREAKDOWN,
    async (_, projectId: string, requestId: string, description: string, attachmentNames?: string[]): Promise<IPCResult<TaskBreakdown>> => {
      const project = projectStore.getProject(projectId);
      if (!project) return { success: false, error: 'Project not found' };
      if (typeof description !== 'string' || !description.trim()) return { success: false, error: 'Description is empty' };

      const controller = new AbortController();
      running.set(requestId, controller);
      try {
        const data = await breakDownTask({
          projectPath: project.path,
          description,
          attachmentNames: Array.isArray(attachmentNames) ? attachmentNames.filter((n) => typeof n === 'string') : undefined,
          abortSignal: controller.signal,
        });
        return { success: true, data };
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return { success: false, error: 'cancelled' };
        }
        const message = error instanceof Error ? error.message : String(error);
        appLog.warn(`[TASK_BREAKDOWN] Failed: ${message}`);
        return { success: false, error: message };
      } finally {
        running.delete(requestId);
      }
    }
  );

  onIpc(IPC_CHANNELS.TASK_BREAKDOWN_CANCEL, (_, requestId: string) => {
    running.get(requestId)?.abort();
  });
}
