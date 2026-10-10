/**
 * MCP connectors for Claude Code runs
 * ===================================
 *
 * Turns a task's connector ids (Settings > Connectors defaults, or the task's own choice) into
 * the JSON accepted by `claude --mcp-config`. The servers are added on top of whatever the
 * user's own Claude Code configuration (.mcp.json, ~/.claude.json, plugins) already loads.
 */

import type { CustomMcpServer } from '../../shared/types/project';
import type { McpConnectorSettings } from '../../shared/types/settings';
import { getDefaultMcpConnectorIds, getUsableCustomServers } from '../../shared/utils/mcp-connectors';

type McpServerEntry =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface ClaudeMcpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** Built-in connectors (Settings > Connectors) */
const BUILTIN_SERVERS: Record<string, McpServerEntry> = {
  context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
  electron: { type: 'stdio', command: 'npx', args: ['-y', 'electron-mcp-server'] },
  puppeteer: { type: 'stdio', command: 'npx', args: ['-y', '@anthropic-ai/puppeteer-mcp-server'] },
};

function customServerEntry(server: CustomMcpServer): McpServerEntry | null {
  if (server.type === 'command') {
    return server.command ? { type: 'stdio', command: server.command, args: server.args ?? [] } : null;
  }
  return server.url ? { type: 'http', url: server.url, headers: server.headers } : null;
}

/** MCP server key accepted by Claude Code (letters, digits, `_` and `-`) */
function serverKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Build the `--mcp-config` object for the given connector ids.
 * `ids` undefined means "use the Connectors defaults".
 */
export function buildMcpConfig(ids: string[] | undefined, connectorSettings: McpConnectorSettings | undefined): ClaudeMcpConfig {
  const enabled = ids ?? getDefaultMcpConnectorIds(connectorSettings);
  const custom = getUsableCustomServers(connectorSettings);
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const id of enabled) {
    const builtin = BUILTIN_SERVERS[id];
    if (builtin) {
      mcpServers[id] = builtin;
      continue;
    }
    const server = custom.find((s) => s.id === id);
    const entry = server ? customServerEntry(server) : null;
    if (entry) mcpServers[serverKey(server!.name || id)] = entry;
  }
  return { mcpServers };
}
