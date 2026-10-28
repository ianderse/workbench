/** Agent backend IPC handlers: detects the OMP CLI for Settings > Agents. */
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { OmpDetection } from '../../shared/types/omp-detection';
import { appLog } from '../app-logger';
import { getAgentBackendSettings } from '../agent-backend/settings';
import { refreshOmpRoles } from '../agent-backend/omp-roles';
import { detectOmp } from '../agent-backend/omp-detection';

export function registerAgentBackendHandlers(): void {
  // Read the OMP model roles in the background so the first run already knows them
  if (getAgentBackendSettings().kind === 'omp') void refreshOmpRoles();
  ipcMain.handle(IPC_CHANNELS.AGENT_BACKEND_DETECT_OMP, async (): Promise<IPCResult<OmpDetection>> => {
    try {
      return { success: true, data: await detectOmp() };
    } catch (error) {
      appLog.error('[AgentBackend] OMP detection failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
