import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const installed = new Set<string>();
const servers: Record<string, (proc: FakeProcess) => void> = {};

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn() };
}

vi.mock('../mcp-commands', () => ({
  isCommandAvailable: async (command: string) => installed.has(command),
  findWslCommand: async () => ({ path: null, windowsOnly: false }),
}));
vi.mock('../platform/shell-runtime', () => ({ getWslInfo: () => null, whenShellRuntimeReady: async () => undefined }));
vi.mock('../platform/runtime-exec', () => ({
  spawnTool: (_tool: string, args: string[]) => {
    const proc = new FakeProcess();
    setTimeout(() => servers[args.join(' ')]?.(proc), 0);
    return proc;
  },
  killRuntimeProcess: vi.fn(),
  toRuntimeArg: (arg: string) => arg,
}));
vi.mock('../platform', () => ({ isWindows: () => false }));
vi.mock('../cli-utils', () => ({ getToolEnvAsync: async () => ({ PATH: '/usr/bin' }) }));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn() } }));

let getMcpAvailability: typeof import('../mcp-availability').getMcpAvailability;
let onMcpAvailabilityChange: typeof import('../mcp-availability').onMcpAvailabilityChange;
let usableMcpConnectorIds: typeof import('../mcp-availability').usableMcpConnectorIds;

const answer = (proc: FakeProcess) => proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
const crash = (proc: FakeProcess) => {
  proc.stderr.emit('data', Buffer.from('npm error 404 Not Found\n'));
  proc.emit('close', 1);
};

describe('MCP availability', () => {
  // Results are kept for the app session: each test starts with none
  beforeEach(async () => {
    installed.clear();
    vi.resetModules();
    ({ getMcpAvailability, onMcpAvailabilityChange, usableMcpConnectorIds } = await import('../mcp-availability'));
  });

  it('is preparing until the server answers, then ready or unavailable', async () => {
    installed.add('npx');
    servers['-y @upstash/context7-mcp@latest'] = answer;
    servers['-y @modelcontextprotocol/server-puppeteer'] = crash;
    const changes: Record<string, string> = {};
    const stop = onMcpAvailabilityChange((id, availability) => {
      changes[id] = availability.state;
    });

    expect(getMcpAvailability(['context7', 'puppeteer'], undefined)).toEqual({
      context7: { state: 'preparing' },
      puppeteer: { state: 'preparing' },
    });
    // A run still includes servers being prepared
    expect(usableMcpConnectorIds(['context7', 'puppeteer'], undefined)).toEqual(['context7', 'puppeteer']);

    await vi.waitFor(() => expect(changes).toEqual({ context7: 'ready', puppeteer: 'unavailable' }));
    expect(getMcpAvailability(['puppeteer'], undefined).puppeteer).toEqual({ state: 'unavailable', message: 'npm error 404 Not Found' });
    // ...and leaves out the ones that can't start
    expect(usableMcpConnectorIds(['context7', 'puppeteer'], undefined)).toEqual(['context7']);
    stop();
  });

  it("checks Puppeteer's browser and says how to install it", async () => {
    installed.add('npx');
    const calls: unknown[] = [];
    servers['-y @modelcontextprotocol/server-puppeteer'] = (proc) => {
      proc.stdin.write.mockImplementation((line: string) => {
        const message = JSON.parse(line);
        calls.push(message);
        if (message.method === 'tools/call') {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            error: { code: -32603, message: 'Could not find Chrome (ver. 131.0.6778.204). This can occur if either\n 1. you did not install it' },
          }) + '\n'));
        }
      });
      answer(proc);
    };
    const settings = { customServers: [] };
    getMcpAvailability(['puppeteer'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['puppeteer'], settings).puppeteer.state).toBe('unavailable'));
    expect(getMcpAvailability(['puppeteer'], settings).puppeteer).toEqual({
      state: 'unavailable',
      message: 'Could not find Chrome (ver. 131.0.6778.204)',
      fixCommand: 'npx puppeteer browsers install chrome@131.0.6778.204',
    });
    // It opened a blank page in a hidden browser
    expect(calls).toContainEqual(expect.objectContaining({
      method: 'tools/call',
      params: { name: 'puppeteer_navigate', arguments: { url: 'about:blank', launchOptions: { headless: true } } },
    }));
  });

  it('names the missing command', async () => {
    const settings = { customServers: [{ id: 'py', name: 'Py', type: 'command' as const, command: 'uvx', args: ['tool'], verified: true }] };
    getMcpAvailability(['py'], settings);
    await vi.waitFor(() => expect(getMcpAvailability(['py'], settings).py).toEqual({ state: 'unavailable', missingCommand: 'uvx' }));
  });
});
