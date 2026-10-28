import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = { windows: false, wsl: false };

vi.mock('../../platform', () => ({ isWindows: () => platform.windows }));
vi.mock('../../platform/shell-runtime', () => ({
  getWslInfo: () => (platform.wsl ? { distro: 'Ubuntu', tools: { npx: { path: '/usr/bin/npx' } } } : null),
}));
vi.mock('../../platform/runtime-exec', () => ({ toRuntimeArg: (arg: string) => arg }));
vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn() } }));

import { buildMcpConfig } from '../mcp-config';

describe('built-in MCP servers', () => {
  beforeEach(() => {
    platform.windows = false;
    platform.wsl = false;
  });

  it('runs electron-mcp-server with node where its script has no shebang to rely on', () => {
    const electron = buildMcpConfig(['electron'], undefined).mcpServers.electron;
    expect(electron).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '-p', 'electron-mcp-server', '-c', 'node "$(command -v electron-mcp-server)"'],
    });

    platform.windows = true;
    platform.wsl = true;
    expect(buildMcpConfig(['electron'], undefined).mcpServers.electron).toEqual(electron);
  });

  it("starts electron-mcp-server through npm's shim on Windows", () => {
    platform.windows = true;
    expect(buildMcpConfig(['electron'], undefined).mcpServers.electron).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'electron-mcp-server'],
    });
  });

  it("uses the MCP project's Puppeteer server", () => {
    expect(buildMcpConfig(['puppeteer'], undefined).mcpServers.puppeteer).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    });
  });
});
