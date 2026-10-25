/**
 * Project windows: one window per project, so several projects can be worked on at once.
 *
 * The first window restores the project it showed last; further windows are opened for a
 * project from the Projects page ("New window"). The open windows are saved
 * (window-session.ts) and all come back after a restart. Each window tells the main process which
 * project it shows (`WINDOW_REPORT_PROJECT`), so the tray menu can list the open projects
 * and the Projects page can focus a project that already has a window.
 */

import type { BrowserWindow } from 'electron';
import type { ProjectWindowInfo } from '../shared/types';
import { appLog } from './app-logger';

interface WindowEntry {
  window: BrowserWindow;
  /** Project the window shows: the one it was opened for, then what its renderer reports */
  projectId: string | null;
  /** Opened for a project, rather than being the window that restores the one it showed last */
  assigned: boolean;
}

const entries = new Map<number, WindowEntry>();
const changeListeners = new Set<() => void>();
/** Windows asked to close for real ("Quit window"), so hide-to-tray steps aside */
const closingForReal = new Set<number>();
/** Last window the user worked in, for the tray and for windowless fallbacks */
let lastFocusedId: number | null = null;
/** Live windows, rebuilt only when a window opens or closes (events hit this on every send) */
let liveCache: BrowserWindow[] | null = null;

/** Entries whose window is still alive and not already closing */
function liveEntries(): WindowEntry[] {
  return [...entries.values()].filter(
    (entry) => !entry.window.isDestroyed() && !closingForReal.has(entry.window.id)
  );
}

function notifyChanged(): void {
  liveCache = null;
  for (const listener of changeListeners) {
    try {
      listener();
    } catch (error) {
      appLog.warn('[window-manager] Change listener failed:', error);
    }
  }
}

/** Run `listener` whenever a window opens, closes or switches project */
export function onProjectWindowsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Track a new window; `projectId` is the project it was opened for */
export function registerWindow(window: BrowserWindow, projectId: string | null): void {
  const id = window.id;
  entries.set(id, { window, projectId, assigned: projectId !== null });
  lastFocusedId = id;
  window.on('focus', () => {
    lastFocusedId = id;
  });
  window.on('closed', () => {
    entries.delete(id);
    closingForReal.delete(id);
    if (lastFocusedId === id) lastFocusedId = null;
    notifyChanged();
  });
  notifyChanged();
}

/** The renderer reports the project it shows (its active project) */
export function setWindowProject(windowId: number, projectId: string | null): void {
  const entry = entries.get(windowId);
  if (!entry || entry.projectId === projectId) return;
  entry.projectId = projectId;
  notifyChanged();
}

/** Project a window shows (null when it shows none, or the window is gone) */
export function getWindowProject(windowId: number): string | null {
  return entries.get(windowId)?.projectId ?? null;
}

/** Every live window with the project it shows */
export function listProjectWindows(): ProjectWindowInfo[] {
  return liveEntries().map((entry) => ({ windowId: entry.window.id, projectId: entry.projectId }));
}

/**
 * Live windows with the project each shows and whether it was opened for it, in window order.
 * Windows hidden to the tray are included (they are open); one closing for real is not.
 */
export function listWindowEntries(): { window: BrowserWindow; projectId: string | null; assigned: boolean }[] {
  return liveEntries().map(({ window, projectId, assigned }) => ({ window, projectId, assigned }));
}

/** Live windows, in creation order (the first one is the window the app started with) */
export function getAllWindows(): BrowserWindow[] {
  liveCache ??= liveEntries().map((entry) => entry.window);
  return liveCache;
}

export function getWindowCount(): number {
  return getAllWindows().length;
}

/** The window the user is working in (the focused one, else the one used last) */
export function getFocusedWindow(): BrowserWindow | null {
  const windows = getAllWindows();
  return (
    windows.find((window) => window.isFocused()) ??
    windows.find((window) => window.id === lastFocusedId) ??
    windows[0] ??
    null
  );
}

/** The window showing `projectId`, optionally ignoring the window that asked */
export function findWindowForProject(projectId: string, exceptWindowId?: number): BrowserWindow | null {
  for (const entry of liveEntries()) {
    if (entry.projectId === projectId && entry.window.id !== exceptWindowId) return entry.window;
  }
  return null;
}

/** Bring a window to the front (restoring it when minimized or hidden to the tray) */
export function showWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Bring one of the open windows to the front by id (tray menu entries) */
export function focusWindowById(windowId: number): void {
  const window = entries.get(windowId)?.window;
  if (window) showWindow(window);
}

/**
 * Focus the window already showing `projectId`.
 *
 * @returns true when such a window exists (and was focused)
 */
export function focusProjectWindow(projectId: string, exceptWindowId?: number): boolean {
  const window = findWindowForProject(projectId, exceptWindowId);
  if (!window) return false;
  showWindow(window);
  return true;
}

/**
 * Mark a window as closing for real, so the close handler doesn't hide it to the tray.
 *
 * It leaves the live set at once (its renderer is on its way out), and the tray and the
 * other windows are told, rather than listing a window that is already going.
 */
export function markClosingForReal(windowId: number): void {
  if (closingForReal.has(windowId)) return;
  closingForReal.add(windowId);
  notifyChanged();
}

export function isClosingForReal(windowId: number): boolean {
  return closingForReal.has(windowId);
}

/**
 * Forget every window
 * @internal Test hook
 */
export function resetWindowRegistry(): void {
  entries.clear();
  closingForReal.clear();
  changeListeners.clear();
  lastFocusedId = null;
  liveCache = null;
}
