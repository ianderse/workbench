/**
 * Graphify API for renderer process: the Graphify CLI's version and installation, and each
 * project's memory graph
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import type { GraphifyIndexInfo, GraphifyVersionInfo } from '../../../shared/types/cli';
import { invokeIpc } from './ipc-utils';

export interface GraphifyAPI {
  /** Installed and latest Graphify versions (forceRefresh re-detects the CLI) */
  checkGraphifyVersion: (forceRefresh?: boolean) => Promise<IPCResult<GraphifyVersionInfo>>;
  /** Open a terminal that installs or updates Graphify */
  installGraphify: () => Promise<IPCResult<{ command: string }>>;
  /** The project's memory graph, or null when it has not been built */
  getGraphifyIndex: (projectId: string) => Promise<IPCResult<GraphifyIndexInfo | null>>;
  /** Build (or rebuild) the project's memory graph in .auto-claude/memory */
  buildGraphifyIndex: (projectId: string) => Promise<IPCResult<GraphifyIndexInfo>>;
}

export const createGraphifyAPI = (): GraphifyAPI => ({
  checkGraphifyVersion: (forceRefresh?: boolean) => invokeIpc(IPC_CHANNELS.GRAPHIFY_CHECK_VERSION, forceRefresh),
  installGraphify: () => invokeIpc(IPC_CHANNELS.GRAPHIFY_INSTALL),
  getGraphifyIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.GRAPHIFY_GET_INDEX, projectId),
  buildGraphifyIndex: (projectId: string) => invokeIpc(IPC_CHANNELS.GRAPHIFY_BUILD_INDEX, projectId),
});
