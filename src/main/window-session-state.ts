/**
 * Restoring project windows after a restart: the pure rules (no Electron here, so they are
 * unit-tested) plus the saver that decides when the saved list may change.
 *
 * The saved list holds one record per open project window, in window order. It is rewritten
 * (debounced) when windows open, close, switch project, move or resize. It is NEVER rewritten
 * once the app starts quitting: windows close one by one during a quit, and saving then would
 * shrink the list to nothing. Closing a window while the app keeps running does remove it.
 */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindow {
  projectId: string;
  /** Opened for a project (argument at creation) as opposed to the first window, which restores the project it showed last */
  assigned: boolean;
  /** Normal (not maximized) bounds; null when unknown */
  bounds: WindowBounds | null;
  maximized: boolean;
  fullscreen: boolean;
  /** The window used last */
  focused: boolean;
}

/** A live window as the saver sees it */
export interface WindowSnapshot {
  projectId: string | null;
  assigned: boolean;
  bounds: WindowBounds | null;
  maximized: boolean;
  fullscreen: boolean;
  focused: boolean;
}

export interface RestoreItem {
  /** Project the window is opened for; null = the first window, which restores the project it showed last */
  assignedProjectId: string | null;
  bounds: WindowBounds | null;
  maximized: boolean;
  fullscreen: boolean;
  focus: boolean;
}

export const MIN_RESTORED_WIDTH = 800;
export const MIN_RESTORED_HEIGHT = 500;
/** Part of a window that must overlap a display for the window to count as being on it */
const MIN_VISIBLE_WIDTH = 200;
const MIN_VISIBLE_HEIGHT = 100;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** One window per project: the first record wins; at most one record is marked focused */
export function dedupeByProject(records: SavedWindow[]): SavedWindow[] {
  const seen = new Set<string>();
  const result: SavedWindow[] = [];
  let focusedTaken = false;
  for (const record of records) {
    if (seen.has(record.projectId)) continue;
    seen.add(record.projectId);
    const focused: boolean = record.focused && !focusedTaken;
    focusedTaken = focusedTaken || focused;
    result.push({ ...record, focused });
  }
  return result;
}

/** Read the saved file's content; anything unexpected is dropped rather than trusted */
export function parseSavedSession(raw: unknown): SavedWindow[] {
  const list = (raw as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(list)) return [];
  const result: SavedWindow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.projectId !== 'string' || !record.projectId) continue;
    result.push({
      projectId: record.projectId,
      assigned: record.assigned !== false,
      bounds: parseBounds(record.bounds),
      maximized: record.maximized === true,
      fullscreen: record.fullscreen === true,
      focused: record.focused === true
    });
  }
  return dedupeByProject(result);
}

/** The list to save for the live windows (in window order); windows showing no project aren't listed */
export function snapshotToRecords(windows: WindowSnapshot[]): SavedWindow[] {
  const records: SavedWindow[] = [];
  for (const window of windows) {
    if (!window.projectId) continue;
    records.push({
      projectId: window.projectId,
      assigned: window.assigned,
      bounds: window.bounds,
      maximized: window.maximized,
      fullscreen: window.fullscreen,
      focused: window.focused
    });
  }
  return dedupeByProject(records);
}

function overlap(a: WindowBounds, b: WindowBounds): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/**
 * Fit saved bounds to the displays that exist now. `workAreas[0]` is the primary display.
 * A window that is no longer (enough) on any display is centered on the primary one.
 */
export function clampBoundsToDisplays(bounds: WindowBounds, workAreas: WindowBounds[]): WindowBounds {
  if (workAreas.length === 0) return bounds;
  let best: WindowBounds | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(bounds, area);
    if (
      o.width >= Math.min(MIN_VISIBLE_WIDTH, bounds.width) &&
      o.height >= Math.min(MIN_VISIBLE_HEIGHT, bounds.height)
    ) {
      const size = o.width * o.height;
      if (size > bestArea) {
        best = area;
        bestArea = size;
      }
    }
  }
  const area = best ?? workAreas[0];
  const width = Math.min(Math.max(bounds.width, Math.min(MIN_RESTORED_WIDTH, area.width)), area.width);
  const height = Math.min(Math.max(bounds.height, Math.min(MIN_RESTORED_HEIGHT, area.height)), area.height);
  if (!best) {
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height
    };
  }
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height
  };
}

/**
 * What to open at startup. Records of projects that no longer exist are skipped, as are
 * duplicates. Only one window is opened without an assigned project (the first window that
 * was one): it restores its project from the shared tab state, the others open for theirs.
 */
export function planRestore(
  saved: SavedWindow[],
  projectExists: (projectId: string) => boolean,
  workAreas: WindowBounds[]
): RestoreItem[] {
  const items: RestoreItem[] = [];
  let unassignedTaken = false;
  for (const record of dedupeByProject(saved)) {
    if (!projectExists(record.projectId)) continue;
    const useShared: boolean = !record.assigned && !unassignedTaken;
    unassignedTaken = unassignedTaken || useShared;
    items.push({
      assignedProjectId: useShared ? null : record.projectId,
      bounds: record.bounds ? clampBoundsToDisplays(record.bounds, workAreas) : null,
      maximized: record.maximized,
      fullscreen: record.fullscreen,
      focus: record.focused
    });
  }
  return items;
}

export interface WindowSessionSaverOptions {
  /** Current list to save */
  snapshot: () => SavedWindow[];
  write: (windows: SavedWindow[]) => void | Promise<void>;
  delayMs?: number;
}

/**
 * Debounced writer of the saved list.
 *
 * Starts disabled (while startup restores windows, the live set is only partly built) and is
 * frozen for good once the app quits. A frozen saver cancels any pending write: windows that
 * close because of the quit must not shorten the list.
 */
export class WindowSessionSaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private frozen = false;
  private lastWritten: string | null = null;

  constructor(private readonly options: WindowSessionSaverOptions) {}

  /** Start saving (after the startup restore); also saves the current state */
  enable(): void {
    if (this.frozen) return;
    this.enabled = true;
    this.schedule();
  }

  /** The app is quitting: keep the list as it was */
  freeze(): void {
    this.frozen = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  /** Something changed (window opened, closed, moved, switched project) */
  schedule(): void {
    if (!this.enabled || this.frozen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.options.delayMs ?? 1000);
  }

  private save(): void {
    if (!this.enabled || this.frozen) return;
    const windows = this.options.snapshot();
    const serialized = JSON.stringify(windows);
    if (serialized === this.lastWritten) return;
    this.lastWritten = serialized;
    void this.options.write(windows);
  }
}
