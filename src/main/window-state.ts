/**
 * Window state: every open window's project, place, size and state (maximized, full screen),
 * kept in the global app settings (`windows`) and reopened on the next launch, each on the
 * display it was on, with the window the user worked in last on top.
 *
 * The list is saved a moment after any window moves, resizes, changes state, opens, closes
 * or switches project, and once more when the app quits, before any window closes. A window
 * hidden to the tray is still open (the tray lists it), so it is saved with the state it had
 * when it was last visible. An older single `windowState` is read as a one-window list.
 */

import { screen, type BrowserWindow, type Rectangle } from 'electron';
import type { SavedWindowState, WindowState } from '../shared/types';
import { appLog } from './app-logger';
import { getSettingsPath, readSettingsFile } from './settings-utils';
import { writeFileAtomicSync } from './utils/atomic-file';
import { getAllWindows, getFocusedWindow, getWindowProject, onProjectWindowsChanged } from './window-manager';

/** Part of a saved window that must stay on a display for its place to be kept */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 50;
/** Size a saved window falls back to when its normal bounds are unknown */
const FALLBACK_SIZE = { width: 1400, height: 900 };
/** Wait for moves and resizes to settle before saving */
const SAVE_DELAY_MS = 1000;
/** Window managers can ignore full screen asked for while a window is being mapped */
const FULL_SCREEN_RETRY_MS = 500;

export interface DisplayArea {
  id: number;
  workArea: Rectangle;
}

/** How a window reopens: its project, its bounds on today's displays and its state */
export interface RestoredWindow {
  projectId: string | null;
  /** Null when its display is gone: the default size, centred on the primary display */
  bounds: Rectangle | null;
  isMaximized: boolean;
  isFullScreen: boolean;
  /** The window the user worked in last (shown active, the others behind it) */
  focused: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A saved window state, or null when it is missing or malformed */
export function parseWindowState(value: unknown): WindowState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  const { x, y, width, height } = state;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    isMaximized: state.isMaximized === true,
    isFullScreen: state.isFullScreen === true,
    ...(isFiniteNumber(state.displayId) ? { displayId: state.displayId } : {})
  };
}

/** The saved windows in settings (`windows`, else an older single `windowState`) */
export function parseSavedWindows(settings: Record<string, unknown> | undefined): SavedWindowState[] {
  if (!settings) return [];
  if (Array.isArray(settings.windows)) {
    const windows: SavedWindowState[] = [];
    for (const entry of settings.windows as unknown[]) {
      const state = parseWindowState(entry);
      if (!state) continue;
      const { projectId, focused, main } = entry as Record<string, unknown>;
      windows.push({
        ...state,
        projectId: typeof projectId === 'string' && projectId ? projectId : null,
        ...(focused === true ? { focused: true } : {}),
        ...(main === true ? { main: true } : {})
      });
    }
    return windows;
  }
  const legacy = parseWindowState(settings.windowState);
  return legacy ? [{ ...legacy, projectId: null, focused: true, main: true }] : [];
}

/**
 * The windows to reopen, the focused one last so it ends up on top: the main window (opened
 * for no project, as it reopens the project it showed last), then one window per other saved
 * project that still exists (the first entry of each). Without any, one main window placed
 * like the focused entry.
 */
export function planWindowRestore(
  saved: SavedWindowState[],
  projectExists: (projectId: string) => boolean
): SavedWindowState[] {
  const main = saved.find((entry) => entry.main);
  const seen = new Set<string>(main?.projectId ? [main.projectId] : []);
  const windows: SavedWindowState[] = main ? [{ ...main, projectId: null }] : [];
  for (const entry of saved) {
    if (entry.main || !entry.projectId || seen.has(entry.projectId) || !projectExists(entry.projectId)) continue;
    seen.add(entry.projectId);
    windows.push(entry);
  }
  if (windows.length === 0) {
    const fallback = saved.find((entry) => entry.focused) ?? saved[0];
    return fallback ? [{ ...fallback, projectId: null, focused: true, main: true }] : [];
  }
  if (!windows.some((entry) => entry.focused)) {
    windows[windows.length - 1] = { ...windows[windows.length - 1], focused: true };
  }
  return [...windows.filter((entry) => !entry.focused), ...windows.filter((entry) => entry.focused)];
}

/** The overlap of two rectangles (zero width/height when they don't overlap) */
function intersect(a: Rectangle, b: Rectangle): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  };
}

/** Whether enough of `bounds` lies on `area` for the user to see and grab it */
function showsEnough(bounds: Rectangle, area: Rectangle): boolean {
  const overlap = intersect(bounds, area);
  return (
    overlap.width >= Math.min(MIN_VISIBLE_WIDTH, bounds.width) &&
    overlap.height >= Math.min(MIN_VISIBLE_HEIGHT, bounds.height)
  );
}

/** Fit `bounds` inside `area`: shrink it to the area, then move it in */
export function clampToArea(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
  };
}

/**
 * Where a saved window opens among the current displays: on the display it overlaps most
 * (its saved display first), fitted to that display's work area. Null when no display shows
 * enough of it (a monitor was unplugged or rearranged), so the caller falls back to its
 * default size.
 */
export function resolveWindowBounds(state: WindowState, displays: DisplayArea[]): Rectangle | null {
  const bounds: Rectangle = { x: state.x, y: state.y, width: state.width, height: state.height };
  const candidates = displays.filter((display) => showsEnough(bounds, display.workArea));
  if (candidates.length === 0) return null;

  const area = (display: DisplayArea): number => {
    const overlap = intersect(bounds, display.workArea);
    return overlap.width * overlap.height;
  };
  const target =
    candidates.find((display) => display.id === state.displayId && area(display) > 0) ??
    candidates.reduce((best, display) => (area(display) > area(best) ? display : best));
  return clampToArea(bounds, target.workArea);
}

/**
 * The normal bounds to save for a window: Electron's normal bounds, unless they lie off the
 * display the window is on now (some window managers report stale ones for a full screen or
 * maximized window), then the last normal bounds seen on that display, else `fallbackSize`
 * centred on it.
 */
export function pickNormalBounds(
  normal: Rectangle,
  tracked: Rectangle | null,
  currentArea: Rectangle,
  fallbackSize: { width: number; height: number }
): Rectangle {
  if (normal.width > 0 && normal.height > 0 && showsEnough(normal, currentArea)) return normal;
  if (tracked && showsEnough(tracked, currentArea)) return tracked;
  const width = Math.min(fallbackSize.width, currentArea.width);
  const height = Math.min(fallbackSize.height, currentArea.height);
  return {
    x: currentArea.x + Math.round((currentArea.width - width) / 2),
    y: currentArea.y + Math.round((currentArea.height - height) / 2),
    width,
    height
  };
}

function currentDisplays(): DisplayArea[] {
  return screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea }));
}

function toRestored(entry: SavedWindowState, displays: DisplayArea[]): RestoredWindow {
  return {
    projectId: entry.projectId,
    bounds: resolveWindowBounds(entry, displays),
    isMaximized: entry.isMaximized,
    isFullScreen: entry.isFullScreen,
    focused: entry.focused === true
  };
}

function readSavedWindows(): SavedWindowState[] {
  try {
    return parseSavedWindows(readSettingsFile());
  } catch (error) {
    appLog.warn('[window-state] Could not read the saved windows:', error);
    return [];
  }
}

/** The windows to open at launch (empty: open one window as usual) */
export function loadRestoredWindows(projectExists: (projectId: string) => boolean): RestoredWindow[] {
  try {
    const displays = currentDisplays();
    return planWindowRestore(readSavedWindows(), projectExists).map((entry) => toRestored(entry, displays));
  } catch (error) {
    appLog.warn('[window-state] Could not restore the windows:', error);
    return [];
  }
}

/**
 * Where a window reopened from the tray with none open goes: the saved window the user
 * worked in last, for no project (it opens the project it showed last)
 */
export function loadMainWindowState(): RestoredWindow | null {
  try {
    const saved = readSavedWindows();
    const main = saved.find((entry) => entry.focused) ?? saved[0];
    return main ? { ...toRestored(main, currentDisplays()), projectId: null, focused: true } : null;
  } catch (error) {
    appLog.warn('[window-state] Could not restore the window:', error);
    return null;
  }
}

/**
 * Maximize the restored window and/or make it full screen once it is shown, after it was
 * created at its saved bounds, so it does so on the display it was on.
 */
export function applyRestoredWindowState(window: BrowserWindow, state: RestoredWindow): void {
  if (window.isDestroyed()) return;
  if (state.isMaximized) window.maximize();
  if (state.isFullScreen) {
    window.setFullScreen(true);
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isFullScreen()) window.setFullScreen(true);
    }, FULL_SCREEN_RETRY_MS);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Saving
// ─────────────────────────────────────────────────────────────────────────────

/** Last normal (not maximized, full screen or minimized) bounds seen per window */
const trackedBounds = new WeakMap<BrowserWindow, Rectangle>();
/** Last state captured per window, saved for it while it is hidden to the tray or minimized */
const lastCaptured = new WeakMap<BrowserWindow, WindowState>();
/** Windows not opened for a project (they keep the shared tabs) */
const mainWindows = new WeakSet<BrowserWindow>();
let saveTimer: NodeJS.Timeout | null = null;
/** Set once the app quits: windows closing after that don't change what was saved */
let saveStopped = false;
let lastSaved: string | null = null;
let unsubscribeWindowChanges: (() => void) | null = null;

/** The state of a visible window (remembered for it), or null when it is hidden, minimized or gone */
export function captureWindowState(window: BrowserWindow | null): WindowState | null {
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return null;
  const isFullScreen = window.isFullScreen();
  const isMaximized = !isFullScreen && window.isMaximized();
  const display = screen.getDisplayMatching(window.getBounds());
  const bounds =
    isFullScreen || isMaximized
      ? pickNormalBounds(window.getNormalBounds(), trackedBounds.get(window) ?? null, display.workArea, FALLBACK_SIZE)
      : window.getBounds();
  const state = { ...bounds, isMaximized, isFullScreen, displayId: display.id };
  lastCaptured.set(window, state);
  return state;
}

/** Every open window's state, in creation order (windows never seen visible are left out) */
export function collectWindowStates(): SavedWindowState[] {
  const focused = getFocusedWindow();
  const states: SavedWindowState[] = [];
  for (const window of getAllWindows()) {
    const state = captureWindowState(window) ?? lastCaptured.get(window);
    if (!state) continue;
    states.push({
      ...state,
      projectId: getWindowProject(window.id),
      ...(window === focused ? { focused: true } : {}),
      ...(mainWindows.has(window) ? { main: true } : {})
    });
  }
  return states;
}

/** Merge the window list into the settings on disk (in one go, so no other save is lost) */
function writeWindowStates(windows: SavedWindowState[]): void {
  const serialized = JSON.stringify(windows);
  if (serialized === lastSaved) return;
  try {
    const { windowState: _legacy, ...settings } = readSettingsFile() ?? {};
    writeFileAtomicSync(getSettingsPath(), JSON.stringify({ ...settings, windows }, null, 2));
    lastSaved = serialized;
  } catch (error) {
    appLog.warn('[window-state] Could not save the window state:', error);
  }
}

function saveNow(): void {
  if (saveStopped) return;
  const windows = collectWindowStates();
  // Nothing to capture (every window hidden and never seen): keep what was saved
  if (windows.length > 0) writeWindowStates(windows);
}

function scheduleSave(): void {
  if (saveStopped) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DELAY_MS);
}

/**
 * Keep track of a window's state: its last normal bounds, its state just before it closes
 * or hides to the tray, and a save shortly after it changes. A restored window starts with
 * its saved state, so it is kept until it is shown. `isMain`: the window was opened for no
 * project. Call it before the window's own 'close' handler is added, so the window is still
 * visible here.
 */
export function trackWindowState(window: BrowserWindow, restored: RestoredWindow | null, isMain: boolean): void {
  unsubscribeWindowChanges ??= onProjectWindowsChanged(scheduleSave);
  if (isMain) mainWindows.add(window);
  if (restored?.bounds) {
    lastCaptured.set(window, {
      ...restored.bounds,
      isMaximized: restored.isMaximized,
      isFullScreen: restored.isFullScreen
    });
  }

  const remember = (): void => {
    if (window.isDestroyed() || window.isFullScreen() || window.isMaximized() || window.isMinimized()) return;
    trackedBounds.set(window, window.getBounds());
  };
  const changed = (): void => {
    remember();
    scheduleSave();
  };

  remember();
  window.on('resize', changed);
  window.on('move', changed);
  window.on('maximize', changed);
  window.on('unmaximize', changed);
  window.on('enter-full-screen', changed);
  window.on('leave-full-screen', changed);
  window.on('show', changed);
  window.on('close', () => {
    captureWindowState(window);
    scheduleSave();
  });
}

/**
 * Save every open window when the app quits (before any window closes), and stop saving:
 * the windows closing next must not change it.
 */
export function saveWindowStateOnQuit(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveNow();
  saveStopped = true;
}

/**
 * Forget saved-state bookkeeping
 * @internal Test hook
 */
export function resetWindowStateTracking(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  saveStopped = false;
  lastSaved = null;
  unsubscribeWindowChanges?.();
  unsubscribeWindowChanges = null;
}
