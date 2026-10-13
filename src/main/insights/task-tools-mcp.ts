/**
 * How the Claude chat's session reaches its task tools (kept apart from the server so the chat
 * runner doesn't load the tools and the project store)
 */

/** Name of the MCP server in the chat session (tools are `mcp__auto-claude__<tool>`) */
export const TASK_TOOLS_SERVER_NAME = 'auto-claude';

/** MCP server entry for the chat's `--mcp-config` */
export interface TaskToolsMcpServer {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}
