/**
 * Usage page IPC: the cached token usage summary of a project, a refresh and a rebuild from history
 */
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { UsageSummaryResult } from '../../shared/types/usage';
import { handleIpc } from './ipc-registry';
import { projectStore } from '../project-store';
import { getUsageSummary, type UsageSummaryMode } from '../usage/usage-service';

function register(channel: string, mode: UsageSummaryMode): void {
  handleIpc(channel, async (_, projectId: string): Promise<IPCResult<UsageSummaryResult>> => {
    const project = projectStore.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    try {
      return { success: true, data: await getUsageSummary({ id: project.id, path: project.path, autoBuildPath: project.autoBuildPath }, mode) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function registerUsageHandlers(): void {
  register(IPC_CHANNELS.USAGE_GET, 'cached');
  register(IPC_CHANNELS.USAGE_REFRESH, 'refresh');
  register(IPC_CHANNELS.USAGE_REBUILD, 'rebuild');
}
