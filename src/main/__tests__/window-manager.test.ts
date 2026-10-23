import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({}));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn() } }));

import {
  findWindowForProject,
  focusProjectWindow,
  focusWindowById,
  getFocusedWindow,
  getWindowCount,
  getWindowProject,
  isClosingForReal,
  listProjectWindows,
  markClosingForReal,
  onProjectWindowsChanged,
  registerWindow,
  resetWindowRegistry,
  setWindowProject
} from '../window-manager';
import type { BrowserWindow } from 'electron';

/** Minimal stand-in for a BrowserWindow, with the handlers the registry attaches */
function fakeWindow(id: number) {
  const handlers = new Map<string, () => void>();
  const window = {
    id,
    destroyed: false,
    minimized: false,
    shown: false,
    focused: false,
    isDestroyed: () => window.destroyed,
    isMinimized: () => window.minimized,
    isFocused: () => window.focused,
    restore: () => {
      window.minimized = false;
    },
    show: () => {
      window.shown = true;
    },
    focus: () => {
      window.focused = true;
    },
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return window;
    },
    emit: (event: string) => handlers.get(event)?.(),
    close: () => handlers.get('closed')?.()
  };
  return window;
}

type FakeWindow = ReturnType<typeof fakeWindow>;
const register = (window: FakeWindow, projectId: string | null) =>
  registerWindow(window as unknown as BrowserWindow, projectId);

describe('window registry', () => {
  beforeEach(() => resetWindowRegistry());

  it('lists every window with the project it shows', () => {
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    register(first, null);
    register(second, 'proj_2');
    setWindowProject(1, 'proj_1');

    expect(listProjectWindows()).toEqual([
      { windowId: 1, projectId: 'proj_1' },
      { windowId: 2, projectId: 'proj_2' }
    ]);
    expect(getWindowCount()).toBe(2);
  });

  it('starts a window on the project it was opened for, then follows its reports', () => {
    register(fakeWindow(1), 'proj_1');
    expect(getWindowProject(1)).toBe('proj_1');
    setWindowProject(1, 'proj_2');
    expect(getWindowProject(1)).toBe('proj_2');
    expect(getWindowProject(99)).toBeNull();
  });

  it('forgets a window once it closes', () => {
    const window = fakeWindow(1);
    register(window, 'proj_1');
    window.close();
    expect(listProjectWindows()).toEqual([]);
  });

  it('notifies on open, project change and close', () => {
    const changed = vi.fn();
    onProjectWindowsChanged(changed);

    const window = fakeWindow(1);
    register(window, null);
    setWindowProject(1, 'proj_1');
    setWindowProject(1, 'proj_1'); // unchanged, no notification
    window.close();

    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('finds the window showing a project, ignoring the one that asked', () => {
    register(fakeWindow(1), 'proj_1');
    register(fakeWindow(2), 'proj_2');

    expect(findWindowForProject('proj_2')?.id).toBe(2);
    expect(findWindowForProject('proj_2', 2)).toBeNull();
    expect(findWindowForProject('proj_3')).toBeNull();
  });

  it('focuses the window a project is already open in', () => {
    const second = fakeWindow(2);
    second.minimized = true;
    register(fakeWindow(1), 'proj_1');
    register(second, 'proj_2');

    expect(focusProjectWindow('proj_2', 1)).toBe(true);
    expect(second.minimized).toBe(false);
    expect(second.shown).toBe(true);
    expect(second.focused).toBe(true);

    // No other window shows proj_1, so there is nothing to focus
    expect(focusProjectWindow('proj_1', 1)).toBe(false);
  });

  it('marks a window as closing for real, until it is gone', () => {
    const window = fakeWindow(1);
    register(window, 'proj_1');

    expect(isClosingForReal(1)).toBe(false);
    markClosingForReal(1);
    expect(isClosingForReal(1)).toBe(true);
    window.close();
    expect(isClosingForReal(1)).toBe(false);
  });

  it('stops handing out a window that is already closing', () => {
    register(fakeWindow(1), 'proj_1');
    markClosingForReal(1);

    expect(findWindowForProject('proj_1')).toBeNull();
    expect(listProjectWindows()).toEqual([]);
    expect(getWindowCount()).toBe(0);
  });

  it('falls back to the window used last when none has focus', () => {
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    register(first, 'proj_1');
    register(second, 'proj_2');

    // registerWindow records the new window as the one in use
    expect(getFocusedWindow()?.id).toBe(2);

    first.emit('focus');
    expect(getFocusedWindow()?.id).toBe(1);

    second.focused = true;
    expect(getFocusedWindow()?.id).toBe(2);
  });

  it('shows a window by id (tray menu entries)', () => {
    const window = fakeWindow(1);
    window.minimized = true;
    register(window, 'proj_1');

    focusWindowById(1);
    expect(window.shown).toBe(true);
    expect(window.focused).toBe(true);

    focusWindowById(99); // unknown window: nothing happens
  });
});
