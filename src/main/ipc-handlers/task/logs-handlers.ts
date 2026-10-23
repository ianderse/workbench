import { handleIpc } from '../ipc-registry';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, getSpecsDir } from '../../../shared/constants';
import type { ArchivedTaskRun, IPCResult, TaskLogs, TaskLogStreamChunk } from '../../../shared/types';
import path from 'path';
import { projectStore } from '../../project-store';
import { taskLogService } from '../../task-log-service';
import { listPreviousRuns } from '../../task-run-archive';
import { isValidTaskId } from '../../utils/spec-path-helpers';
import { debugLog } from '../../../shared/utils/debug-logger';
import { ensureAbsolutePath } from '../../utils/path-helpers';
import { safeSendToRenderer } from '../utils';

/**
 * Register task logs handlers
 */
export function registerTaskLogsHandlers(getMainWindow: () => BrowserWindow | null): void {
  /**
   * The runs this task was started over from: their logs and the steps of their Claude Code
   * run, oldest first. Empty for a task that was never started over.
   */
  handleIpc(
    IPC_CHANNELS.TASK_PREVIOUS_RUNS_GET,
    async (_, projectId: string, specId: string): Promise<IPCResult<ArchivedTaskRun[]>> => {
      if (!isValidTaskId(specId)) {
        return { success: false, error: 'Invalid spec ID' };
      }
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      try {
        const specDir = path.join(ensureAbsolutePath(project.path), getSpecsDir(project.autoBuildPath), specId);
        return { success: true, data: listPreviousRuns(specDir) };
      } catch (error) {
        console.error('[TASK_PREVIOUS_RUNS_GET] Failed to read the previous runs:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to read the previous runs' };
      }
    }
  );

  /**
   * Get task logs from spec directory
   * Returns logs organized by phase (planning, coding, validation)
   */
  handleIpc(
    IPC_CHANNELS.TASK_LOGS_GET,
    async (_, projectId: string, specId: string): Promise<IPCResult<TaskLogs | null>> => {
      try {
        if (!isValidTaskId(specId)) {
          return { success: false, error: 'Invalid spec ID' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          console.error('[TASK_LOGS_GET] Project not found:', projectId);
          return { success: false, error: 'Project not found' };
        }

        // Defense-in-depth: project.path is normally absolute from ProjectStore,
        // but we guard here against edge cases (e.g., manually edited store file)
        const absoluteProjectPath = ensureAbsolutePath(project.path);
        const specsRelPath = getSpecsDir(project.autoBuildPath);
        const specDir = path.join(absoluteProjectPath, specsRelPath, specId);

        debugLog('[TASK_LOGS_GET] Path resolution:', {
          projectId,
          specId,
          absoluteProjectPath,
          specsRelPath,
          specDir,
        });

        // Don't fail if specDir doesn't exist yet — the agent may not have created it.
        // taskLogService.loadLogs() handles missing directories gracefully (returns null).
        const logs = taskLogService.loadLogs(specDir, absoluteProjectPath, specsRelPath, specId);

        debugLog('[TASK_LOGS_GET] Logs loaded:', {
          specId,
          hasLogs: !!logs,
          phaseCounts: logs ? {
            planning: logs.phases.planning?.entries?.length || 0,
            coding: logs.phases.coding?.entries?.length || 0,
            validation: logs.phases.validation?.entries?.length || 0
          } : null
        });

        return { success: true, data: logs };
      } catch (error) {
        console.error('[TASK_LOGS_GET] Failed to get task logs:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get task logs'
        };
      }
    }
  );

  /**
   * Start watching a spec for log changes
   */
  handleIpc(
    IPC_CHANNELS.TASK_LOGS_WATCH,
    async (_, projectId: string, specId: string): Promise<IPCResult> => {
      try {
        if (!isValidTaskId(specId)) {
          return { success: false, error: 'Invalid spec ID' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          console.error('[TASK_LOGS_WATCH] Project not found:', projectId);
          return { success: false, error: 'Project not found' };
        }

        const absoluteProjectPath = ensureAbsolutePath(project.path);
        const specsRelPath = getSpecsDir(project.autoBuildPath);
        const specDir = path.join(absoluteProjectPath, specsRelPath, specId);

        debugLog('[TASK_LOGS_WATCH] Starting watch:', {
          projectId,
          specId,
          absoluteProjectPath,
          specDir,
        });

        // Start watching even if specDir doesn't exist yet — the poll loop
        // in TaskLogService handles missing files gracefully and will pick up
        // task_logs.json once the agent creates it during execution.
        taskLogService.startWatching(specId, specDir, absoluteProjectPath, specsRelPath, projectId);
        return { success: true };
      } catch (error) {
        console.error('[TASK_LOGS_WATCH] Failed to start watching task logs:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start watching'
        };
      }
    }
  );

  /**
   * Stop watching a spec for log changes
   */
  handleIpc(
    IPC_CHANNELS.TASK_LOGS_UNWATCH,
    async (_, projectId: string, specId: string): Promise<IPCResult> => {
      try {
        if (!isValidTaskId(specId)) {
          return { success: false, error: 'Invalid spec ID' };
        }

        // Watches are counted per spec directory, so one window's unwatch leaves another
        // window watching the same task alone
        const project = projectStore.getProject(projectId);
        if (!project) {
          // The project is gone (removed while its task was open): nothing can be watching
          // it any more, and its directory can no longer be worked out
          taskLogService.stopWatchingSpec(specId);
          return { success: true };
        }
        const specDir = path.join(
          ensureAbsolutePath(project.path),
          getSpecsDir(project.autoBuildPath),
          specId
        );

        taskLogService.stopWatching(specDir);
        return { success: true };
      } catch (error) {
        console.error('Failed to stop watching task logs:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to stop watching'
        };
      }
    }
  );

  /**
   * Setup task log service event forwarding to renderer
   */
  // Every project window gets these; the project id keeps each window to its own task
  taskLogService.on('logs-changed', (specId: string, logs: TaskLogs, projectId?: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOGS_CHANGED, specId, logs, projectId);
  });

  taskLogService.on('stream-chunk', (specId: string, chunk: TaskLogStreamChunk, projectId?: string) => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOGS_STREAM, specId, chunk, projectId);
  });
}
