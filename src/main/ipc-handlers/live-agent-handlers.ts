/**
 * Live agent IPC handlers: the relay's status and the agent windows' graph subscriptions
 * (the relay itself starts and stops with the "Live agent" setting, see live-agent-relay.ts)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, LiveAgentStatus } from '../../shared/types';
import { liveAgentRelay } from '../live-agent/live-agent-relay';

export function registerLiveAgentHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LIVE_AGENT_GET_STATUS, (): IPCResult<LiveAgentStatus> => ({
    success: true,
    data: liveAgentRelay.getStatus(),
  }));

  ipcMain.handle(IPC_CHANNELS.LIVE_AGENT_SUBSCRIBE, (event, clientId: string, cwd: string): IPCResult => {
    if (typeof clientId !== 'string' || typeof cwd !== 'string' || !cwd) {
      return { success: false, error: 'Invalid subscription' };
    }
    liveAgentRelay.subscribe(event.sender, clientId, cwd);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LIVE_AGENT_UNSUBSCRIBE, (event, clientId: string): IPCResult => {
    liveAgentRelay.unsubscribe(event.sender, String(clientId));
    return { success: true };
  });
}
