/**
 * Saves which project windows are open (`window-session.json` in userData) and loads the list
 * back at startup. Rules live in window-session-state.ts.
 *
 * Quit paths: `freezeWindowSession()` is called on `before-quit` (Cmd+Q, tray Quit, OS quit,
 * Windows/Linux closing the last window) and before the updater's `quitAndInstall` (which
 * closes windows before it emits `before-quit`). A kill by SIGTERM/SIGINT (the dev restart)
 * emits nothing, but then the file simply keeps its last written state: it only ever shrinks
 * when a window is closed on purpose, and writes are debounced.
 */

import { app, screen, type BrowserWindow } from 'electron';
import { readFileSync } from 'fs';
import { mkdir, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { appLog } from './app-logger';
import { getFocusedWindow, listWindowEntries } from './window-manager';
import {
  WindowSessionSaver,
  parseSavedSession,
  snapshotToRecords,
  type SavedWindow,
  type WindowBounds,
  type WindowSnapshot
} from './window-session-state';

function sessionFile(): string {
  return join(app.getPath('userData'), 'window-session.json');
}

/** The windows saved by the last run (empty when there is no file or it is unreadable) */
export function loadWindowSession(): SavedWindow[] {
  try {
    return parseSavedSession(JSON.parse(readFileSync(sessionFile(), 'utf-8')));
  } catch {
    return [];
  }
}

/** Bounds, maximized and fullscreen state of a window as it should be restored */
export function readWindowState(window: BrowserWindow): Pick<WindowSnapshot, 'bounds' | 'maximized' | 'fullscreen'> {
  const bounds = window.getNormalBounds();
  return {
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen()
  };
}

/** Work areas of the connected displays, the primary one first */
export function getDisplayWorkAreas(): WindowBounds[] {
  try {
    const primaryId = screen.getPrimaryDisplay().id;
    const displays = [...screen.getAllDisplays()].sort(
      (a, b) => Number(b.id === primaryId) - Number(a.id === primaryId)
    );
    return displays.map((display) => ({ ...display.workArea }));
  } catch (error) {
    appLog.warn('[window-session] Could not read displays:', error);
    return [];
  }
}

function currentSnapshot(): SavedWindow[] {
  const focused = getFocusedWindow();
  const windows: WindowSnapshot[] = [];
  for (const entry of listWindowEntries()) {
    try {
      windows.push({
        projectId: entry.projectId,
        assigned: entry.assigned,
        focused: entry.window === focused,
        ...readWindowState(entry.window)
      });
    } catch {
      // Window destroyed between listing and reading
    }
  }
  return snapshotToRecords(windows);
}

let writeChain: Promise<void> = Promise.resolve();

function writeSession(windows: SavedWindow[]): Promise<void> {
  const file = sessionFile();
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, windows }, null, 2), 'utf-8');
      await rename(tmp, file);
    })
    .catch((error) => appLog.warn('[window-session] Could not save the open windows:', error));
  return writeChain;
}

const saver = new WindowSessionSaver({ snapshot: currentSnapshot, write: writeSession });

/** Start saving (call once the startup restore has opened its windows) */
export function enableWindowSession(): void {
  saver.enable();
}

/** A window opened, closed, moved, resized or switched project */
export function scheduleWindowSessionSave(): void {
  saver.schedule();
}

/** The app is quitting: from now on the saved list stays as it is */
export function freezeWindowSession(): void {
  saver.freeze();
}
