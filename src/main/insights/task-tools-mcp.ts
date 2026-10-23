/**
 * How the Claude chat's session reaches its task tools (kept apart from the server so the chat
 * runner doesn't load the tools and the project store)
 */

/** Name of the MCP server in the chat session (tools are `mcp__workbench__<tool>`) */
export const TASK_TOOLS_SERVER_NAME = 'workbench';

/** MCP server entry for the chat's `--mcp-config`: the app's HTTP server on 127.0.0.1 */
export interface TaskToolsMcpServer {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

/**
 * MCP server entry that reaches the HTTP server through the stdio bridge
 * (`task-tools-bridge.cjs`), for Claude Code inside WSL2 with NAT networking
 */
export interface TaskToolsStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Environment variables the bridge reads (see task-tools-bridge.cjs) */
export const TASK_TOOLS_BRIDGE_URL_ENV = 'WORKBENCH_TASK_TOOLS_URL';
export const TASK_TOOLS_BRIDGE_TOKEN_ENV = 'WORKBENCH_TASK_TOOLS_TOKEN';

/**
 * The bridge entry for an HTTP entry: Claude Code inside WSL starts `executable` (Workbench's
 * own executable, as its Linux path) through WSL interop as Node, running the bridge script
 * (`bridgeScript`, a Windows path: the Windows process reads it). WSLENV takes the variables
 * across to the Windows process; the token stays out of the arguments.
 */
export function toBridgeServer(server: TaskToolsMcpServer, executable: string, bridgeScript: string): TaskToolsStdioServer {
  const token = /^Bearer (.+)$/.exec(server.headers.Authorization ?? '')?.[1] ?? '';
  const forwarded = ['ELECTRON_RUN_AS_NODE', TASK_TOOLS_BRIDGE_URL_ENV, TASK_TOOLS_BRIDGE_TOKEN_ENV];
  return {
    type: 'stdio',
    command: executable,
    args: [bridgeScript],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      [TASK_TOOLS_BRIDGE_URL_ENV]: server.url,
      [TASK_TOOLS_BRIDGE_TOKEN_ENV]: token,
      WSLENV: forwarded.join(':'),
    },
  };
}
