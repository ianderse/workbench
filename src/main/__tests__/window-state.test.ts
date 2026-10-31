import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SavedWindowState } from '../../shared/types';

const settingsFile = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined, writes: [] as string[] }));
const displays = vi.hoisted(() => [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }
]);

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => displays,
    getDisplayMatching: (rect: { x: number }) => (rect.x >= 1920 ? displays[1] : displays[0])
  }
}));
vi.mock('../settings-utils', () => ({
  getSettingsPath: () => '/tmp/settings.json',
  readSettingsFile: () => settingsFile.value
}));
vi.mock('../utils/atomic-file', () => ({
  writeFileAtomicSync: (_path: string, data: string) => {
    settingsFile.writes.push(data);
    settingsFile.value = JSON.parse(data);
  }
}));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const windows = vi.hoisted(() => ({
  list: [] as unknown[],
  focused: null as unknown,
  projects: new Map<number, string | null>()
}));
vi.mock('../window-manager', () => ({
  getAllWindows: () => windows.list,
  getFocusedWindow: () => windows.focused,
  getWindowProject: (id: number) => windows.projects.get(id) ?? null,
  onProjectWindowsChanged: () => () => {}
}));

import {
  captureWindowState,
  clampToArea,
  collectWindowStates,
  loadMainWindowState,
  loadRestoredWindows,
  parseSavedWindows,
  parseWindowState,
  pickNormalBounds,
  planWindowRestore,
  resetWindowStateTracking,
  resolveWindowBounds,
  saveWindowStateOnQuit,
  trackWindowState
} from '../window-state';

type Bounds = { x: number; y: number; width: number; height: number };
let nextId = 1;

function fakeWindow(options: {
  bounds: Bounds;
  normal?: Bounds;
  visible?: boolean;
  fullScreen?: boolean;
  maximized?: boolean;
  projectId?: string | null;
}) {
  const id = nextId++;
  windows.projects.set(id, options.projectId ?? null);
  const state = { visible: options.visible ?? true };
  const window = {
    id,
    state,
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isMinimized: () => false,
    isFullScreen: () => options.fullScreen ?? false,
    isMaximized: () => options.maximized ?? false,
    getBounds: () => options.bounds,
    getNormalBounds: () => options.normal ?? options.bounds,
    on: vi.fn()
  };
  return window as unknown as Electron.BrowserWindow & { state: { visible: boolean } };
}

const entry = (overrides: Partial<SavedWindowState>): SavedWindowState => ({
  x: 100,
  y: 100,
  width: 1400,
  height: 900,
  isMaximized: false,
  isFullScreen: false,
  projectId: null,
  ...overrides
});

beforeEach(() => {
  settingsFile.value = undefined;
  settingsFile.writes = [];
  windows.list = [];
  windows.focused = null;
  windows.projects.clear();
  resetWindowStateTracking();
});

describe('parseWindowState', () => {
  it('accepts a saved state and drops unknown fields', () => {
    expect(
      parseWindowState({ x: 10.4, y: 20, width: 800, height: 600, isFullScreen: true, displayId: 2, extra: 1 })
    ).toEqual({ x: 10, y: 20, width: 800, height: 600, isMaximized: false, isFullScreen: true, displayId: 2 });
  });

  it('rejects missing or malformed states', () => {
    expect(parseWindowState(undefined)).toBeNull();
    expect(parseWindowState('x')).toBeNull();
    expect(parseWindowState({ x: 0, y: 0, width: 0, height: 600 })).toBeNull();
    expect(parseWindowState({ x: 0, y: '0', width: 800, height: 600 })).toBeNull();
    expect(parseWindowState({ x: Number.NaN, y: 0, width: 800, height: 600 })).toBeNull();
  });
});

describe('parseSavedWindows', () => {
  it('reads the window list, skipping malformed entries', () => {
    expect(
      parseSavedWindows({
        windows: [
          { x: 0, y: 0, width: 800, height: 600, projectId: 'a', focused: true, main: true },
          { x: 0, y: 0, width: 0, height: 600, projectId: 'b' },
          { x: 2000, y: 0, width: 800, height: 600, projectId: 7 }
        ]
      })
    ).toEqual([
      entry({ x: 0, y: 0, width: 800, height: 600, projectId: 'a', focused: true, main: true }),
      entry({ x: 2000, y: 0, width: 800, height: 600, projectId: null })
    ]);
  });

  it('reads an older single windowState as the main window', () => {
    expect(parseSavedWindows({ windowState: { x: 5, y: 6, width: 800, height: 600, isFullScreen: true } })).toEqual([
      entry({ x: 5, y: 6, width: 800, height: 600, isFullScreen: true, focused: true, main: true })
    ]);
    expect(parseSavedWindows(undefined)).toEqual([]);
    expect(parseSavedWindows({})).toEqual([]);
  });
});

describe('planWindowRestore', () => {
  const exists = (id: string): boolean => id !== 'gone';

  it('reopens the main window and one window per other project, the focused one last', () => {
    const plan = planWindowRestore(
      [
        entry({ projectId: 'a', main: true }),
        entry({ projectId: 'b', focused: true }),
        entry({ projectId: 'c' })
      ],
      exists
    );
    expect(plan.map((window) => [window.projectId, window.focused ?? false])).toEqual([
      [null, false],
      ['c', false],
      ['b', true]
    ]);
  });

  it('skips missing projects, entries without a project and duplicates', () => {
    const plan = planWindowRestore(
      [
        entry({ projectId: 'a', main: true }),
        entry({ projectId: 'a', x: 1 }),
        entry({ projectId: 'gone' }),
        entry({ projectId: null }),
        entry({ projectId: 'b', x: 2 }),
        entry({ projectId: 'b', x: 3, focused: true })
      ],
      exists
    );
    expect(plan.map((window) => [window.projectId, window.x])).toEqual([
      [null, 100],
      ['b', 2]
    ]);
    expect(plan[1].focused).toBe(true);
  });

  it('falls back to one main window placed like the focused entry', () => {
    expect(
      planWindowRestore([entry({ projectId: 'gone', x: 1 }), entry({ projectId: null, x: 2, focused: true })], exists)
    ).toEqual([entry({ projectId: null, x: 2, focused: true, main: true })]);
    expect(planWindowRestore([], exists)).toEqual([]);
  });
});

describe('clampToArea', () => {
  it('shrinks and moves the window into the area', () => {
    expect(clampToArea({ x: 1800, y: -50, width: 3000, height: 800 }, displays[1].workArea)).toEqual({
      x: 1920,
      y: 0,
      width: 2560,
      height: 800
    });
    expect(clampToArea({ x: 4000, y: 1000, width: 1000, height: 600 }, displays[1].workArea)).toEqual({
      x: 3480,
      y: 800,
      width: 1000,
      height: 600
    });
  });
});

describe('resolveWindowBounds', () => {
  const base = { isMaximized: false, isFullScreen: false };

  it('keeps a window on the secondary display where it was', () => {
    expect(resolveWindowBounds({ ...base, x: 2100, y: 100, width: 1400, height: 900, displayId: 2 }, displays)).toEqual({
      x: 2100,
      y: 100,
      width: 1400,
      height: 900
    });
  });

  it('places a window across two displays on the one it overlaps most', () => {
    expect(resolveWindowBounds({ ...base, x: 1700, y: 100, width: 1000, height: 600 }, displays)).toEqual({
      x: 1920,
      y: 100,
      width: 1000,
      height: 600
    });
  });

  it('prefers the saved display when the window overlaps it', () => {
    expect(resolveWindowBounds({ ...base, x: 1100, y: 100, width: 1000, height: 600, displayId: 2 }, displays)).toEqual({
      x: 1920,
      y: 100,
      width: 1000,
      height: 600
    });
  });

  it('gives up when no display shows enough of the window (monitor unplugged)', () => {
    expect(resolveWindowBounds({ ...base, x: 5000, y: 100, width: 1400, height: 900 }, displays)).toBeNull();
    expect(resolveWindowBounds({ ...base, x: 4450, y: 100, width: 1400, height: 900 }, displays)).toBeNull();
    expect(resolveWindowBounds({ ...base, x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull();
  });
});

describe('pickNormalBounds', () => {
  const area = displays[1].workArea;
  const fallback = { width: 1400, height: 900 };

  it('uses the normal bounds when they are on the current display', () => {
    const normal = { x: 2000, y: 50, width: 1200, height: 800 };
    expect(pickNormalBounds(normal, null, area, fallback)).toBe(normal);
  });

  it('falls back to the tracked bounds, then to a centred default size', () => {
    const stale = { x: 0, y: 0, width: 1200, height: 800 };
    const tracked = { x: 2100, y: 60, width: 1300, height: 850 };
    expect(pickNormalBounds(stale, tracked, area, fallback)).toBe(tracked);
    expect(pickNormalBounds(stale, null, area, fallback)).toEqual({ x: 2500, y: 250, width: 1400, height: 900 });
  });
});

describe('captureWindowState', () => {
  it('saves a full screen window with its pre-full-screen bounds on the same display', () => {
    const window = fakeWindow({
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      normal: { x: 2200, y: 100, width: 1400, height: 900 },
      fullScreen: true
    });
    expect(captureWindowState(window)).toEqual({
      x: 2200,
      y: 100,
      width: 1400,
      height: 900,
      isMaximized: false,
      isFullScreen: true,
      displayId: 2
    });
  });

  it('skips hidden windows', () => {
    expect(captureWindowState(fakeWindow({ bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false }))).toBeNull();
    expect(captureWindowState(null)).toBeNull();
  });
});

describe('saving', () => {
  it('saves every window with its project on quit, keeping other settings, then stops saving', () => {
    settingsFile.value = { theme: 'dark', windowState: { x: 0, y: 0, width: 800, height: 600 } };
    const main = fakeWindow({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      normal: { x: 100, y: 50, width: 1400, height: 900 },
      fullScreen: true,
      projectId: 'a'
    });
    const other = fakeWindow({
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      normal: { x: 2200, y: 100, width: 1400, height: 900 },
      fullScreen: true,
      projectId: 'b'
    });
    trackWindowState(main, null, true);
    trackWindowState(other, null, false);
    windows.list = [main, other];
    windows.focused = other;

    saveWindowStateOnQuit();
    expect(settingsFile.value).toEqual({
      theme: 'dark',
      windows: [
        { x: 100, y: 50, width: 1400, height: 900, isMaximized: false, isFullScreen: true, displayId: 1, projectId: 'a', main: true },
        { x: 2200, y: 100, width: 1400, height: 900, isMaximized: false, isFullScreen: true, displayId: 2, projectId: 'b', focused: true }
      ]
    });

    saveWindowStateOnQuit();
    expect(settingsFile.writes).toHaveLength(1);
  });

  it('saves a window hidden to the tray with the state it had when last visible', () => {
    const shown = fakeWindow({ bounds: { x: 2000, y: 40, width: 1500, height: 1000 }, projectId: 'a' });
    const hidden = fakeWindow({ bounds: { x: 300, y: 200, width: 1200, height: 800 }, projectId: 'b' });
    const neverShown = fakeWindow({ bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false, projectId: 'c' });
    windows.list = [shown, hidden, neverShown];
    windows.focused = shown;

    captureWindowState(hidden);
    hidden.state.visible = false;

    expect(collectWindowStates().map((window) => [window.projectId, window.x])).toEqual([
      ['a', 2000],
      ['b', 300]
    ]);
  });

  it('keeps what was saved when no window can be captured', () => {
    settingsFile.value = { windows: [entry({ projectId: 'a' })] };
    const hidden = fakeWindow({ bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false });
    windows.list = [hidden];
    windows.focused = hidden;
    saveWindowStateOnQuit();
    expect(settingsFile.writes).toHaveLength(0);
  });

  it('starts a reopened window with its saved state until it is shown', () => {
    const window = fakeWindow({ bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false, projectId: 'a' });
    trackWindowState(
      window,
      { projectId: 'a', bounds: { x: 2100, y: 100, width: 1400, height: 900 }, isMaximized: true, isFullScreen: false, focused: true },
      false
    );
    windows.list = [window];
    windows.focused = window;
    expect(collectWindowStates()).toEqual([
      { x: 2100, y: 100, width: 1400, height: 900, isMaximized: true, isFullScreen: false, projectId: 'a', focused: true }
    ]);
  });
});

describe('loading', () => {
  it('places each saved window on today’s displays, falling back when its monitor is gone', () => {
    settingsFile.value = {
      windows: [
        entry({ x: 100, y: 50, projectId: 'a', main: true, isFullScreen: true, displayId: 1 }),
        entry({ x: 6000, y: 100, projectId: 'b', isMaximized: true }),
        entry({ x: 2200, y: 100, projectId: 'c', focused: true, isFullScreen: true, displayId: 2 })
      ]
    };
    expect(loadRestoredWindows(() => true)).toEqual([
      { projectId: null, bounds: { x: 100, y: 50, width: 1400, height: 900 }, isMaximized: false, isFullScreen: true, focused: false },
      { projectId: 'b', bounds: null, isMaximized: true, isFullScreen: false, focused: false },
      { projectId: 'c', bounds: { x: 2200, y: 100, width: 1400, height: 900 }, isMaximized: false, isFullScreen: true, focused: true }
    ]);
  });

  it('reopens one window from the tray placed like the focused saved window', () => {
    settingsFile.value = {
      windows: [entry({ projectId: 'a', main: true }), entry({ x: 2200, projectId: 'b', focused: true })]
    };
    expect(loadMainWindowState()).toEqual({
      projectId: null,
      bounds: { x: 2200, y: 100, width: 1400, height: 900 },
      isMaximized: false,
      isFullScreen: false,
      focused: true
    });

    settingsFile.value = {};
    expect(loadMainWindowState()).toBeNull();
    expect(loadRestoredWindows(() => true)).toEqual([]);
  });
});
