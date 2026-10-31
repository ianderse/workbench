/**
 * MCP Server API
 *
 * Exposes MCP health check and connection test functionality to the renderer.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import type { IPCResult } from '../../../shared/types/common';
import type { CustomMcpServer, McpAvailability, McpHealthCheckResult, McpTestConnectionResult } from '../../../shared/types/project';

export interface McpAPI {
  /** Quick health check for a custom MCP server */
  checkMcpHealth: (server: CustomMcpServer) => Promise<IPCResult<McpHealthCheckResult>>;
  /** Full MCP connection test */
  testMcpConnection: (server: CustomMcpServer) => Promise<IPCResult<McpTestConnectionResult>>;
  /** Whether the connectors' servers can start; unknown ones start being checked */
  getMcpAvailability: (ids: string[]) => Promise<IPCResult<Record<string, McpAvailability>>>;
  /** Called when a connector's availability changes */
  onMcpAvailabilityChanged: (callback: (id: string, availability: McpAvailability) => void) => () => void;
}

export function createMcpAPI(): McpAPI {
  return {
    checkMcpHealth: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server),

    testMcpConnection: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, server),

    getMcpAvailability: (ids: string[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_AVAILABILITY, ids),

    onMcpAvailabilityChanged: (callback: (id: string, availability: McpAvailability) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string, availability: McpAvailability) => callback(id, availability);
      ipcRenderer.on(IPC_CHANNELS.MCP_AVAILABILITY_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.MCP_AVAILABILITY_CHANGED, listener);
      };
    },
  };
}
