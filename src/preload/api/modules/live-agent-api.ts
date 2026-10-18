/**
 * Live agent API for renderer process: each project's "Live agent" setting, the relay's status and
 * the agent windows' graph subscriptions (Settings > Claude Code > Live agent)
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, LiveAgentStatus } from '../../../shared/types';
import { createIpcListener, invokeIpc, type IpcListenerCleanup } from './ipc-utils';

export interface LiveAgentAPI {
  /** Whether the relay is stopped, starting, running or failed */
  getLiveAgentStatus: () => Promise<IPCResult<LiveAgentStatus>>;
  /** Whether the project has Live agent on (its .workbench/flow directory exists) */
  getLiveAgentProject: (projectPath: string) => Promise<IPCResult<boolean>>;
  /** Switch Live agent on (create the flow directory, set up the hooks) or off for a project */
  setLiveAgentProject: (projectPath: string, enabled: boolean) => Promise<IPCResult<{ hooksError?: string }>>;
  /** Show a graph (clientId, made by the renderer) the Claude Code sessions run in cwd, in the
   *  project; terminalId is the agent window the graph belongs to */
  subscribeLiveAgent: (clientId: string, cwd: string, projectPath: string, terminalId: string) => Promise<IPCResult>;
  unsubscribeLiveAgent: (clientId: string) => Promise<IPCResult>;
  /** The relay started, stopped or failed */
  onLiveAgentStatus: (callback: (status: LiveAgentStatus) => void) => IpcListenerCleanup;
  /** A relay message (JSON, as agent-flow's SSE stream sends it) for one graph */
  onLiveAgentMessage: (callback: (clientId: string, data: string) => void) => IpcListenerCleanup;
}

export const createLiveAgentAPI = (): LiveAgentAPI => ({
  getLiveAgentStatus: () => invokeIpc(IPC_CHANNELS.LIVE_AGENT_GET_STATUS),
  getLiveAgentProject: (projectPath: string) => invokeIpc(IPC_CHANNELS.LIVE_AGENT_GET_PROJECT, projectPath),
  setLiveAgentProject: (projectPath: string, enabled: boolean) =>
    invokeIpc(IPC_CHANNELS.LIVE_AGENT_SET_PROJECT, projectPath, enabled),
  subscribeLiveAgent: (clientId: string, cwd: string, projectPath: string, terminalId: string) =>
    invokeIpc(IPC_CHANNELS.LIVE_AGENT_SUBSCRIBE, clientId, cwd, projectPath, terminalId),
  unsubscribeLiveAgent: (clientId: string) => invokeIpc(IPC_CHANNELS.LIVE_AGENT_UNSUBSCRIBE, clientId),
  onLiveAgentStatus: (callback: (status: LiveAgentStatus) => void) =>
    createIpcListener(IPC_CHANNELS.LIVE_AGENT_STATUS, callback),
  onLiveAgentMessage: (callback: (clientId: string, data: string) => void) =>
    createIpcListener(IPC_CHANNELS.LIVE_AGENT_MESSAGE, callback),
});
