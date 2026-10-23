/**
 * Finding an agent window's latest Claude Code session in the WSL runtime: Claude Code runs inside
 * WSL, so the project's folder is named after its Linux path (`-mnt-c-...`) and lives under the
 * Linux home's config dir, which the app reads through its UNC path.
 */
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const INFO = { distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/' };

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn((_dir: string) => true),
  readdirSync: vi.fn((_dir: string) => ['old.jsonl', 'new.jsonl', 'notes.txt']),
  statSync: vi.fn((file: string) => ({ mtime: new Date(String(file).includes('new') ? 2000 : 1000) })),
}));
vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()), ...fsMocks }));
vi.mock('../../platform', () => ({ isWindows: () => true, isMacOS: () => false }));
vi.mock('../../platform/shell-runtime', async () => {
  const { windowsToWsl, wslToWindows } = await vi.importActual<typeof import('../../platform/wsl-paths')>(
    '../../platform/wsl-paths'
  );
  return {
    getWslInfo: () => INFO,
    toRuntimePath: (p: string) => windowsToWsl(p, INFO) ?? p,
    toHostPath: (p: string) => wslToWindows(p, INFO),
  };
});
vi.mock('../../terminal-session-store', () => ({
  getTerminalSessionStore: vi.fn(),
  flushTerminalSessionStores: vi.fn(),
}));

import { findMostRecentClaudeSession } from '../session-handler';

const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findMostRecentClaudeSession in WSL', () => {
  it("looks under the Linux home's ~/.claude, in the folder named after the Linux path", () => {
    expect(findMostRecentClaudeSession('C:\\Users\\me\\repo')).toBe('new');
    expect(fsMocks.existsSync).toHaveBeenCalledWith(path.join(`${HOME}\\.claude`, 'projects', '-mnt-c-Users-me-repo'));
  });

  it("reads a profile's config dir given as a Linux path through its UNC path", () => {
    findMostRecentClaudeSession('C:\\Users\\me\\repo', '/home/me/.claude-work');
    expect(fsMocks.existsSync).toHaveBeenCalledWith(path.join(`${HOME}\\.claude-work`, 'projects', '-mnt-c-Users-me-repo'));
  });
});
