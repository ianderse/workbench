/**
 * Usage page API for the renderer: a project's token usage summary
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { UsageSummaryResult } from '../../../shared/types/usage';
import { invokeIpc } from './ipc-utils';

export interface UsageAPI {
  /** The summary the main process holds (computes it once when there is none) */
  getUsageSummary: (projectId: string) => Promise<IPCResult<UsageSummaryResult>>;
  /** Read the ledger again */
  refreshUsageSummary: (projectId: string) => Promise<IPCResult<UsageSummaryResult>>;
  /** Import the tasks' earlier sessions again, then read the ledger */
  rebuildUsageFromHistory: (projectId: string) => Promise<IPCResult<UsageSummaryResult>>;
}

export const createUsageAPI = (): UsageAPI => ({
  getUsageSummary: (projectId: string) => invokeIpc(IPC_CHANNELS.USAGE_GET, projectId),
  refreshUsageSummary: (projectId: string) => invokeIpc(IPC_CHANNELS.USAGE_REFRESH, projectId),
  rebuildUsageFromHistory: (projectId: string) => invokeIpc(IPC_CHANNELS.USAGE_REBUILD, projectId),
});
