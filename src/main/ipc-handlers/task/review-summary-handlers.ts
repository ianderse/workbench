import path from 'path';
import { BrowserWindow } from 'electron';
import { handleIpc } from '../ipc-registry';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { ReviewSummary } from '../../../shared/types/claude-code';
import { resolveEffectiveAgent } from '../../../shared/utils/agent-override';
import { getAgentBackendSettings } from '../../agent-backend/settings';
import { loadClaudeRunInfo, saveClaudeRunInfo } from '../../claude-code/task-runner';
import { generateReviewSummary, trackReviewSummary } from '../../claude-code/review-summary';
import { appLog } from '../../app-logger';
import { safeSendToRenderer } from '../utils';
import { findTaskAndProject } from './shared';
import { collectTaskChanges } from './worktree-handlers';

/**
 * Writes the reviewer summary for a task that has none (it finished before summaries existed, or
 * the background one failed). Generated once and stored in `claude_run.json`; `force` is the
 * "Regenerate" button. Answers null when generation fails: the panel falls back to the agent's notes.
 */
export function registerReviewSummaryHandlers(getMainWindow: () => BrowserWindow | null): void {
  handleIpc(
    IPC_CHANNELS.TASK_REVIEW_SUMMARY_GENERATE,
    async (_, taskId: string, projectId?: string, force?: boolean): Promise<IPCResult<ReviewSummary | null>> => {
      try {
        const { task, project } = findTaskAndProject(taskId, projectId);
        if (!task || !project) return { success: false, error: 'Task not found' };
        const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
        const info = loadClaudeRunInfo(specDir);
        if (!info) return { success: true, data: null };
        if (info.reviewSummary && !force) return { success: true, data: info.reviewSummary };

        const key = `${project.id}:${task.specId}`;
        const summary = await trackReviewSummary(key, async () => {
          const changes = await collectTaskChanges(task, project).catch(() => null);
          const made = await generateReviewSummary({
            info,
            title: task.title,
            request: task.description,
            changes,
            backend: resolveEffectiveAgent(task.metadata?.agentOverride, getAgentBackendSettings().kind).backend,
            projectPath: project.path,
            projectId: project.id,
            taskId: task.specId,
          });
          if (!made) return null;
          // Re-read: the file may have changed while the model wrote
          const latest = loadClaudeRunInfo(specDir) ?? info;
          latest.reviewSummary = made;
          latest.updatedAt = new Date().toISOString();
          saveClaudeRunInfo(specDir, latest);
          safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_CLAUDE_RUN_UPDATE, task.id, latest, project.id);
          return made;
        });
        return { success: true, data: summary };
      } catch (error) {
        appLog.warn(`[TASK_REVIEW_SUMMARY_GENERATE] ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );
}
