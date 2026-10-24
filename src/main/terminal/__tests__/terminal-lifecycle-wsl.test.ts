/**
 * Where an agent window opens while the session's tools run in WSL: a window with no folder of its
 * own belongs in the distribution's home, not in the Windows home (which WSL sees as
 * `/mnt/c/Users/<user>`, a directory that holds none of the user's Linux setup).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as pty from '@lydell/node-pty';

const INFO = { distro: 'Ubuntu', user: 'me', home: '/home/me', mountRoot: '/mnt/' };

vi.mock('../../platform', () => ({ isWindows: () => true }));
vi.mock('../../platform/shell-runtime', async () => {
  const { wslToWindows } = await vi.importActual<typeof import('../../platform/wsl-paths')>('../../platform/wsl-paths');
  return {
    whenShellRuntimeReady: async () => ({}),
    getWslInfo: () => INFO,
    toHostPath: (p: string) => wslToWindows(p, INFO),
  };
});

const mockSpawnPty = vi.fn(() => ({
  pty: { pid: 1234, write: vi.fn() } as unknown as pty.IPty,
  shellKind: 'posix' as const,
}));
vi.mock('../pty-manager', () => ({
  getActiveProfileEnv: () => ({}),
  spawnPtyProcess: (...args: unknown[]) => mockSpawnPty(...(args as [])),
  setupPtyHandlers: vi.fn(),
}));
vi.mock('../session-handler', () => ({ clearPendingDelete: vi.fn(), persistSessionAsync: vi.fn() }));
vi.mock('../../graphify-paths', () => ({ getGraphifyOutDir: vi.fn(), hasGraphifyGraph: async () => false }));
vi.mock('../../self-improve/setting', () => ({ isSelfImproveEnabledForPath: async () => false }));
vi.mock('../../ipc-handlers/utils', () => ({ safeSendToRenderer: vi.fn() }));

import { createTerminal } from '../terminal-lifecycle';
import type { TerminalProcess } from '../types';

/** The Linux home as the app stores every path, through the distribution's UNC share */
const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';

beforeEach(() => {
  mockSpawnPty.mockClear();
});

describe('createTerminal in WSL', () => {
  it("opens a window with no folder in the distribution's home", async () => {
    const terminals = new Map<string, TerminalProcess>();

    const result = await createTerminal({ id: 'term-1' }, terminals, () => null, vi.fn());

    expect(result.success).toBe(true);
    expect(mockSpawnPty).toHaveBeenCalledWith(WSL_HOME, 80, 24, expect.anything());
    // The window remembers the same host path, which is what a later restore starts it in
    expect(terminals.get('term-1')?.cwd).toBe(WSL_HOME);
  });
});
