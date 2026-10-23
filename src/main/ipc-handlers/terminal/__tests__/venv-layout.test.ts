/**
 * Worktree venvs follow the layout of the OS the tools run on: `Scripts\python.exe` on native
 * Windows, `bin/python` on macOS/Linux and in WSL (Linux venvs, run inside the distribution).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const mocks = vi.hoisted(() => ({ windows: false, wsl: false }));

vi.mock('../../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform')>()),
  isWindows: () => mocks.windows,
}));
vi.mock('../../../platform/shell-runtime', () => ({
  isWslRuntime: () => mocks.wsl,
  toRuntimePath: (p: string) => p,
  toHostPath: (p: string) => p,
  getWslInfo: () => null,
  whenShellRuntimeReady: async () => ({}),
}));
vi.mock('../../../live-agent/project-setup', () => ({ addToWorktree: vi.fn() }));
vi.mock('../../../project-store', () => ({ projectStore: { getProjects: () => [] } }));

import { usesWindowsVenvLayout, venvExecutable } from '../worktree-handlers';

beforeEach(() => {
  mocks.windows = false;
  mocks.wsl = false;
});

describe('venv layout by runtime', () => {
  it('native Windows: Scripts with .exe', () => {
    mocks.windows = true;
    expect(usesWindowsVenvLayout()).toBe(true);
    expect(venvExecutable('venv', 'python')).toBe(path.join('venv', 'Scripts', 'python.exe'));
    expect(venvExecutable('venv', 'pip')).toBe(path.join('venv', 'Scripts', 'pip.exe'));
  });

  it('WSL on Windows: bin, like Linux', () => {
    mocks.windows = true;
    mocks.wsl = true;
    expect(usesWindowsVenvLayout()).toBe(false);
    expect(venvExecutable('venv', 'python')).toBe(path.join('venv', 'bin', 'python'));
    expect(venvExecutable('venv', 'pip')).toBe(path.join('venv', 'bin', 'pip'));
  });

  it('macOS / Linux: bin', () => {
    expect(usesWindowsVenvLayout()).toBe(false);
    expect(venvExecutable('venv', 'python')).toBe(path.join('venv', 'bin', 'python'));
  });
});
