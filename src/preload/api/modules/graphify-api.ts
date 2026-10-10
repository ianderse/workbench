/**
 * Graphify API for renderer process: the Graphify CLI's version and installation, and each
 * project's memory graph
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { GraphifyGraph, GraphifyIndexInfo, GraphifyVersionInfo } from '../../../shared/types/cli';
import { createIpcListener, invokeIpc, type IpcListenerCleanup } from './ipc-utils';

export interface GraphifyAPI {
  /** Installed and latest Graphify versions (forceRefresh re-detects the CLI) */
  checkGraphifyVersion: (forceRefresh?: boolean) => Promise<IPCResult<GraphifyVersionInfo>>;
  /** Open a terminal that installs or updates Graphify */
  installGraphify: () => Promise<IPCResult<{ command: string }>>;
  /** Make the /graphify command available in Claude Code (each config directory lacking it) */
  installGraphifyClaudeCommand: () => Promise<IPCResult<{ configDirs: number; missing: number }>>;
  /** The project's memory graph, or null when it has not been built */
  getGraphifyIndex: (projectId: string) => Promise<IPCResult<GraphifyIndexInfo | null>>;
  /** Build (or rebuild) the project's memory graph in .auto-claude/knowledge */
  buildGraphifyIndex: (projectId: string) => Promise<IPCResult<GraphifyIndexInfo>>;
  /** Whether the project has a memory graph (.auto-claude/knowledge) */
  hasGraphifyGraph: (projectId: string) => Promise<IPCResult<boolean>>;
  /** The project's memory graph for the graph view */
  getGraphifyGraph: (projectId: string) => Promise<IPCResult<GraphifyGraph | null>>;
  /** A project's memory graph was rebuilt in the background (after a task completed) */
  onGraphifyIndexUpdated: (callback: (projectId: string, info: GraphifyIndexInfo) => void) => IpcListenerCleanup;
}

export const createGraphifyAPI = (): GraphifyAPI => ({
  checkGraphifyVersion: (forceRefresh?: boolean) => invokeIpc(IPC_CHANNELS.GRAPHIFY_CHECK_VERSION, forceRefresh),
  installGraphify: () => invokeIpc(IPC_CHANNELS.GRAPHIFY_INSTALL),
  installGraphifyClaudeCommand: () => invokeIpc(IPC_CHANNELS.GRAPHIFY_INSTALL_CLAUDE_COMMAND),
  getGraphifyIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.GRAPHIFY_GET_INDEX, projectId),
  buildGraphifyIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.GRAPHIFY_BUILD_INDEX, projectId),
  hasGraphifyGraph: (projectId: string) => invokeIpc(IPC_CHANNELS.GRAPHIFY_HAS_GRAPH, projectId),
  getGraphifyGraph: (projectId: string) => invokeIpc(IPC_CHANNELS.GRAPHIFY_GET_GRAPH, projectId),
  onGraphifyIndexUpdated: (callback: (projectId: string, info: GraphifyIndexInfo) => void) =>
    createIpcListener(IPC_CHANNELS.GRAPHIFY_INDEX_UPDATED, callback),
});
