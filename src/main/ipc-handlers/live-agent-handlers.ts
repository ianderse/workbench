/**
 * Live agent IPC handlers: each project's "Live agent" setting, the relay's status and the agent
 * windows' graph subscriptions (the relay runs while any project has Live agent on, see
 * live-agent/live-agent-projects.ts)
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, LiveAgentStatus } from '../../shared/types';
import { appLog } from '../app-logger';
import { liveAgentRelay } from '../live-agent/live-agent-relay';
import { isKnownProject, isLiveAgentEnabled, setLiveAgentEnabled } from '../live-agent/live-agent-projects';
import { getFlowDir } from '../live-agent/project-setup';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerLiveAgentHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LIVE_AGENT_GET_STATUS, (): IPCResult<LiveAgentStatus> => ({
    success: true,
    data: liveAgentRelay.getStatus(),
  }));

  // Whether the project has Live agent on (its .workbench/flow directory exists)
  ipcMain.handle(IPC_CHANNELS.LIVE_AGENT_GET_PROJECT, async (_event, projectPath: string): Promise<IPCResult<boolean>> => {
    if (!isKnownProject(projectPath)) return { success: false, error: 'Project not found' };
    const enabled = await isLiveAgentEnabled(projectPath);
    // A project that has it on (e.g. added again after a restart) needs the relay
    if (enabled) liveAgentRelay.setEnabled(true);
    return { success: true, data: enabled };
  });

  ipcMain.handle(
    IPC_CHANNELS.LIVE_AGENT_SET_PROJECT,
    async (_event, projectPath: string, enabled: boolean): Promise<IPCResult<{ hooksError?: string }>> => {
      if (!isKnownProject(projectPath)) return { success: false, error: 'Project not found' };
      try {
        return { success: true, data: await setLiveAgentEnabled(projectPath, enabled === true) };
      } catch (error) {
        appLog.error('[LiveAgent] Could not change the setting:', error);
        return { success: false, error: errorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.LIVE_AGENT_SUBSCRIBE,
    (event, clientId: string, cwd: string, projectPath: string, terminalId: string): IPCResult => {
      if (typeof clientId !== 'string' || typeof cwd !== 'string' || !cwd || !isKnownProject(projectPath)) {
        return { success: false, error: 'Invalid subscription' };
      }
      liveAgentRelay.subscribe(event.sender, clientId, cwd, getFlowDir(projectPath), String(terminalId ?? ''));
      return { success: true };
    }
  );

  ipcMain.handle(IPC_CHANNELS.LIVE_AGENT_UNSUBSCRIBE, (event, clientId: string): IPCResult => {
    liveAgentRelay.unsubscribe(event.sender, String(clientId));
    return { success: true };
  });
}
