/**
 * MCP connectors: the built-in servers plus the user's tested custom servers. Settings > Connectors
 * holds the defaults; each task stores the ids enabled for it (TaskMetadata.mcpConnectors).
 */

import type { McpConnectorSettings } from '../types/settings';
import type { CustomMcpServer } from '../types/project';

/** Custom servers that can be used: only ones that passed a connection test */
export function getUsableCustomServers(settings: McpConnectorSettings | undefined): CustomMcpServer[] {
  return (settings?.customServers ?? []).filter((server) => server.verified);
}

/** Ids of the connectors switched on in the defaults */
export function getDefaultMcpConnectorIds(settings: McpConnectorSettings | undefined): string[] {
  return [
    ...(settings?.context7Enabled !== false ? ['context7'] : []),
    ...(settings?.electronEnabled === true ? ['electron'] : []),
    ...(settings?.puppeteerEnabled === true ? ['puppeteer'] : []),
    ...getUsableCustomServers(settings)
      .filter((server) => server.enabled !== false)
      .map((server) => server.id),
  ];
}
