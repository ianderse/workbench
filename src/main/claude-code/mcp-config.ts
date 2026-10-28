/**
 * MCP connectors for Claude Code runs
 * ===================================
 *
 * Turns a task's connector ids (Settings > Connectors defaults, or the task's own choice) into
 * the JSON accepted by `claude --mcp-config`. The servers are added on top of whatever the
 * user's own Claude Code configuration (.mcp.json, ~/.claude.json, plugins) already loads.
 *
 * When Claude Code runs in WSL it starts the servers inside the distribution: Windows paths in a
 * custom server's command and arguments are translated, and the built-in servers need npx there.
 */

import type { CustomMcpServer } from '../../shared/types/project';
import type { McpConnectorSettings } from '../../shared/types/settings';
import { getDefaultMcpConnectorIds, getUsableCustomServers } from '../../shared/utils/mcp-connectors';
import { appLog } from '../app-logger';
import { getWslInfo } from '../platform/shell-runtime';
import { isWindows } from '../platform';
import { toRuntimeArg } from '../platform/runtime-exec';

export type McpServerEntry =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface ClaudeMcpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/**
 * electron-mcp-server's executable has no `#!/usr/bin/env node` line, so on Linux and macOS (and
 * in WSL) the shell runs it as a script and it fails at once; there npx runs it with node.
 * Windows starts it through npm's .cmd shim, which already uses node
 */
function electronServer(): McpServerEntry {
  const posix = !isWindows() || !!getWslInfo();
  return posix
    ? { type: 'stdio', command: 'npx', args: ['-y', '-p', 'electron-mcp-server', '-c', 'node "$(command -v electron-mcp-server)"'] }
    : { type: 'stdio', command: 'npx', args: ['-y', 'electron-mcp-server'] };
}

/** Built-in connectors (Settings > Connectors) */
function builtinServer(id: string): McpServerEntry | undefined {
  switch (id) {
    case 'context7':
      return { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };
    case 'electron':
      return electronServer();
    case 'puppeteer':
      // The MCP project's Puppeteer server (downloads Chromium the first time)
      return { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] };
    default:
      return undefined;
  }
}

function customServerEntry(server: CustomMcpServer): McpServerEntry | null {
  if (server.type === 'command') {
    if (!server.command) return null;
    // In WSL, whole-argument Windows paths become the distribution's paths (as for every tool launch)
    const translate = getWslInfo() ? toRuntimeArg : (arg: string) => arg;
    return { type: 'stdio', command: translate(server.command), args: (server.args ?? []).map(translate) };
  }
  return server.url ? { type: 'http', url: server.url, headers: server.headers } : null;
}

/**
 * How long Claude Code waits for MCP servers to start (MCP_TIMEOUT). Its 30 second default is too
 * short for a server's first start, when npx downloads it (Puppeteer also downloads Chromium);
 * later starts come from npx's cache
 */
export const MCP_STARTUP_TIMEOUT_MS = 3 * 60 * 1000;

/** MCP server key accepted by Claude Code (letters, digits, `_` and `-`) */
function serverKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

let warnedNoNpx = false;

/** The built-in servers run with npx; in WSL that has to be the distribution's npx */
function warnWhenNpxMissingInWsl(): void {
  const wsl = getWslInfo();
  if (!wsl || wsl.tools.npx.path || warnedNoNpx) return;
  warnedNoNpx = true;
  appLog.warn(
    `[MCP] npx isn't installed in WSL (${wsl.distro}), so the built-in connectors (Context7, Electron, Puppeteer) ` +
    "can't start in Claude Code runs there. Install Node.js inside WSL to use them"
  );
}

/** One connector's server entry, as a Claude Code run would start it (null when it can't be) */
export function mcpServerEntry(id: string, connectorSettings: McpConnectorSettings | undefined): McpServerEntry | null {
  const builtin = builtinServer(id);
  if (builtin) return builtin;
  const server = getUsableCustomServers(connectorSettings).find((s) => s.id === id);
  return server ? customServerEntry(server) : null;
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
    const builtin = builtinServer(id);
    if (builtin) {
      warnWhenNpxMissingInWsl();
      mcpServers[id] = builtin;
      continue;
    }
    const server = custom.find((s) => s.id === id);
    const entry = server ? customServerEntry(server) : null;
    if (entry) mcpServers[serverKey(server!.name || id)] = entry;
  }
  return { mcpServers };
}
