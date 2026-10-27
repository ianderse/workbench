import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { shell, type BrowserWindow } from 'electron';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult, TaskMetadata } from '../../../shared/types';
import type { HumanWorkMutation, HumanWorkstream } from '../../../shared/types/human-work';
import { applyHumanWorkMutation, isHumanApprovalOverride } from '../../../shared/utils/human-work';
import { projectStore } from '../../project-store';
import { taskQueue } from '../../services/task-queue';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { taskHooks } from '../../task-hooks';
import { appLog } from '../../app-logger';
import { handleIpc, invokeIpcHandler } from '../ipc-registry';
import { safeSendToRenderer } from '../utils';
import { findTaskAndProject } from './shared';
import { notificationService } from '../../notification-service';
import { getHumanReviewPacket, reviewArtifactPath } from '../../self-improve/human-review-artifacts';

let listening = false;

/** Newly classified human-only blockers become tracked actions without consuming an agent slot. */
export async function collectHumanReviewActions(projectId: string, taskId: string): Promise<void> {
  projectStore.invalidateTasksCache(projectId);
  const { task } = findTaskAndProject(taskId, projectId);
  if (isHumanApprovalOverride(task?.metadata?.humanWork?.approvalOverride)) return;
  const findings = task?.claudeRun?.reviewVerdict?.failure?.openFindings.filter((finding) => finding.requiresHuman === true) ?? [];
  for (const finding of findings) {
    const current = findTaskAndProject(taskId, projectId).task;
    if (!current || current.status !== 'human_review') return;
    const result = await invokeIpcHandler<IPCResult<HumanWorkstream>>(IPC_CHANNELS.TASK_HUMAN_WORK, projectId, taskId, { action: 'create', expectedRevision: current.metadata?.humanWork?.revision ?? 0, finding });
    if (!result.success) throw new Error(result.error);
  }
}

export function registerHumanWorkHandlers(getMainWindow: () => BrowserWindow | null): void {
  handleIpc(IPC_CHANNELS.TASK_HUMAN_REVIEW_PACKET, async (_event, projectId: string, taskId: string) => {
    try {
      const { project, task } = findTaskAndProject(taskId, projectId);
      if (!project || !task) throw new Error('Task not found in this project');
      return { success: true, data: await getHumanReviewPacket(project, task) };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  handleIpc(IPC_CHANNELS.TASK_HUMAN_REVIEW_OPEN, async (_event, projectId: string, taskId: string, reference: string, action: 'open' | 'reveal', expectedRoot: string) => {
    try {
      if (action !== 'open' && action !== 'reveal') throw new Error('Invalid artifact action');
      const { project, task } = findTaskAndProject(taskId, projectId);
      if (!project || !task) throw new Error('Task not found in this project');
      const packet = await getHumanReviewPacket(project, task);
      if (packet.root !== expectedRoot) throw new Error('Review checkout changed; refresh the file links before opening');
      if (!packet.artifacts.some(item => item.path === reference && item.available)) throw new Error('Review artifact is no longer available');
      const resolved = await reviewArtifactPath(packet.root, reference);
      if (!resolved) throw new Error('Review artifact is no longer available');
      if (action === 'reveal') shell.showItemInFolder(resolved);
      else { const error = await shell.openPath(resolved); if (error) throw new Error(error); }
      return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  handleIpc(IPC_CHANNELS.TASK_HUMAN_WORK, async (_event, projectId: string, taskId: string, mutation: HumanWorkMutation): Promise<IPCResult<HumanWorkstream>> => {
    try {
      return await taskQueue.runExclusive(projectId, async () => {
        projectStore.invalidateTasksCache(projectId);
        const { project, task } = findTaskAndProject(taskId, projectId);
        if (!project || !task || task.metadata?.archivedAt) throw new Error('Task not found in this project');
        if (task.status !== 'human_review') throw new Error('Human work can be edited while the task waits in Human Review');
        const file = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId, 'task_metadata.json');
        let metadata: TaskMetadata;
        try { metadata = JSON.parse(readFileSync(file, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; metadata = task.metadata ?? {}; }
        const stream = applyHumanWorkMutation(metadata.humanWork, mutation, task.claudeRun?.reviewVerdict?.failure?.openFindings ?? [], randomUUID(), new Date().toISOString());
        const changed = stream.revision !== (metadata.humanWork?.revision ?? 0);
        if (changed) {
          writeFileAtomicSync(file, JSON.stringify({ ...metadata, humanWork: stream }, null, 2));
          projectStore.invalidateTasksCache(projectId);
          safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_HUMAN_WORK_CHANGED, projectId);
          if (mutation.action === 'create') notificationService.notifyContent({ kind: 'review-needed', title: 'Human work needed', body: task.title, route: { projectId, taskId } });
        }
        return { success: true, data: stream };
      });
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  });
  if (!listening) {
    listening = true;
    taskHooks.on('state', ({ project, task, status }) => {
      if (status === 'human_review') void collectHumanReviewActions(project.id, task.id).catch((error) => appLog.warn('[HumanWork] Could not track human requirements:', error));
    });
  }
}
