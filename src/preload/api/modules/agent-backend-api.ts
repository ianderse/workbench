/** Agent backend API for renderer process: OMP detection (Settings > Agents) */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { OmpDetection } from '../../../shared/types/omp-detection';
import { invokeIpc } from './ipc-utils';

export interface AgentBackendAPI {
  /** OMP version and models (uses the command saved in Settings) */
  detectOmp: () => Promise<IPCResult<OmpDetection>>;
}

export const createAgentBackendAPI = (): AgentBackendAPI => ({
  detectOmp: () => invokeIpc(IPC_CHANNELS.AGENT_BACKEND_DETECT_OMP),
});
