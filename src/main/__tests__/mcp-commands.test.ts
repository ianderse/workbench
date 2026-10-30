/**
 * Where an MCP server's command is installed (mcp-commands): on Windows the path spawn can start
 * (npm's `npx.cmd`, not the POSIX `npx` script next to it), cached until looked up again
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  windows: false,
  files: new Set<string>(),
  nodePath: null as string | null,
  whereOutput: '',
  execFile: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const { promisify } = await import('util');
  Object.defineProperty(mocks.execFile, promisify.custom, {
    configurable: true,
    value: (...args: unknown[]) => Promise.resolve(mocks.execFile(...args)),
  });
  return { ...(await importOriginal<typeof import('child_process')>()), execFile: mocks.execFile };
});
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: (file: string) => mocks.files.has(file),
}));
vi.mock('../platform', () => ({ isWindows: () => mocks.windows }));
vi.mock('../platform/shell-runtime', () => ({ getWslInfo: () => null, whenShellRuntimeReady: async () => undefined }));
vi.mock('../platform/wsl-exec-basic', () => ({ execInWsl: vi.fn() }));
vi.mock('../platform/wsl-detect', () => ({ isUnderMountRoot: () => false }));
vi.mock('../utils/windows-paths', () => ({ getWhereExePath: () => 'C:\\Windows\\System32\\where.exe' }));
vi.mock('../cli-tool-manager', () => ({
  getToolInfoAsync: async () => (mocks.nodePath ? { found: true, path: mocks.nodePath } : { found: false }),
}));
vi.mock('../cli-utils', () => ({ getToolEnvAsync: async () => ({ PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }) }));

import path from 'path';
import { isCommandAvailable, pickWindowsMatch, resetCommandLookups, resolveCommand } from '../mcp-commands';

beforeEach(() => {
  vi.clearAllMocks();
  resetCommandLookups();
  mocks.windows = false;
  mocks.files.clear();
  mocks.nodePath = null;
  mocks.execFile.mockImplementation(() => ({ stdout: mocks.whereOutput, stderr: '' }));
});

describe('resolveCommand', () => {
  it("finds Windows npx as the .cmd shim next to the detected node", async () => {
    mocks.windows = true;
    mocks.nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const npx = path.join(path.dirname(mocks.nodePath), 'npx.cmd');
    mocks.files.add(npx);
    await expect(resolveCommand('npx')).resolves.toBe(npx);
    await expect(isCommandAvailable('npx')).resolves.toBe(true);
  });

  it("takes where.exe's first match Windows can start", async () => {
    mocks.windows = true;
    mocks.whereOutput = 'C:\\Users\\me\\AppData\\Roaming\\npm\\uvx\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\uvx.cmd\r\n';
    await expect(resolveCommand('uvx')).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\uvx.cmd');
    expect(mocks.execFile.mock.calls[0][0]).toBe('C:\\Windows\\System32\\where.exe');
  });

  it('is null when nothing found can start', async () => {
    mocks.windows = true;
    mocks.whereOutput = 'C:\\tools\\server\r\n';
    await expect(resolveCommand('server')).resolves.toBeNull();
    await expect(isCommandAvailable('server')).resolves.toBe(false);
  });

  it('caches lookups until refreshed or reset', async () => {
    mocks.whereOutput = '/usr/bin/uvx\n';
    await expect(resolveCommand('uvx')).resolves.toBe('/usr/bin/uvx');
    mocks.whereOutput = '/opt/uv/bin/uvx\n';
    await expect(resolveCommand('uvx')).resolves.toBe('/usr/bin/uvx');
    await expect(resolveCommand('uvx', { refresh: true })).resolves.toBe('/opt/uv/bin/uvx');
    mocks.whereOutput = '/home/me/.local/bin/uvx\n';
    resetCommandLookups();
    await expect(resolveCommand('uvx')).resolves.toBe('/home/me/.local/bin/uvx');
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });
});

describe('pickWindowsMatch', () => {
  it('skips matches without a runnable extension', () => {
    expect(pickWindowsMatch('C:\\a\\npx\nC:\\a\\npx.CMD\n', ['.exe', '.cmd'])).toBe('C:\\a\\npx.CMD');
    expect(pickWindowsMatch('', ['.exe'])).toBeNull();
  });
});
