/**
 * MCP checks while the app runs its tools in WSL (Claude Code starts the servers there):
 * - the health check looks the command up inside WSL; a Windows-only program is reported clearly
 * - the connection test starts the server inside WSL through the runtime layer and stops it there
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const mocks = vi.hoisted(() => ({
  found: new Map<string, string>(),
  spawnTool: vi.fn(),
  killRuntimeProcess: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  getWslInfo: () => ({ distro: 'Ubuntu', mountRoot: '/mnt/' }),
}));
vi.mock('../../platform/wsl-exec-basic', () => ({
  execInWsl: async (_file: string, args: string[]) => {
    const found = mocks.found.get(args[args.length - 1]);
    if (!found) throw Object.assign(new Error('not found'), { code: 1 });
    return { stdout: `${found}\n`, stderr: '' };
  },
}));
vi.mock('../../platform/runtime-exec', () => ({ spawnTool: mocks.spawnTool, killRuntimeProcess: mocks.killRuntimeProcess }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import { registerMcpHandlers } from '../mcp-handlers';

registerMcpHandlers();

const invoke = (channel: string, server: unknown) =>
  (ipcMain as unknown as { invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<{ data: Record<string, unknown> }> })
    .invokeHandler(channel, {}, server);

/** A server process that answers the initialize request */
function fakeServer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.stdin.on('data', () => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
  });
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.found.clear();
});

describe('MCP health check in WSL', () => {
  it('finds the command inside WSL', async () => {
    mocks.found.set('npx', '/usr/bin/npx');
    const { data } = await invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, { id: 's', name: 'S', type: 'command', command: 'npx', args: ['-y', 'pkg'] });
    expect(data).toMatchObject({ status: 'healthy', message: "Command 'npx' found in WSL" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reports a command only installed on Windows', async () => {
    mocks.found.set('npx', '/mnt/c/Program Files/nodejs/npx');
    const { data } = await invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, { id: 's', name: 'S', type: 'command', command: 'npx' });
    expect(data.status).toBe('unhealthy');
    expect(data.message).toContain('only installed on Windows');
    expect(data.message).toContain('Ubuntu');
  });

  it('reports a missing command', async () => {
    const { data } = await invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, { id: 's', name: 'S', type: 'command', command: 'uvx' });
    expect(data).toMatchObject({ status: 'unhealthy', message: "Command 'uvx' not found in WSL (Ubuntu)" });
  });
});

describe('MCP connection test in WSL', () => {
  it('starts the server inside WSL and stops it there', async () => {
    mocks.found.set('node', '/usr/bin/node');
    const child = fakeServer();
    mocks.spawnTool.mockReturnValue(child);

    const { data } = await invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, {
      id: 's', name: 'S', type: 'command', command: 'node', args: ['C:\\servers\\mcp.js'],
    });
    expect(data).toMatchObject({ success: true, message: 'MCP server started successfully' });
    // The Windows path argument is translated by the runtime layer
    expect(mocks.spawnTool).toHaveBeenCalledWith('python', ['C:\\servers\\mcp.js'], expect.objectContaining({ command: '/usr/bin/node' }));
    expect(mocks.killRuntimeProcess).toHaveBeenCalledWith(child);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("doesn't start anything when the command isn't in WSL", async () => {
    const { data } = await invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, { id: 's', name: 'S', type: 'command', command: 'npx' });
    expect(data).toMatchObject({ success: false, message: "Command 'npx' not found in WSL (Ubuntu)" });
    expect(mocks.spawnTool).not.toHaveBeenCalled();
  });
});
