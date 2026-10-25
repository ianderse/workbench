import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WindowSessionSaver,
  clampBoundsToDisplays,
  dedupeByProject,
  parseSavedSession,
  planRestore,
  snapshotToRecords,
  type SavedWindow,
  type WindowSnapshot
} from '../window-session-state';

const bounds = { x: 100, y: 100, width: 1200, height: 800 };
const saved = (projectId: string, extra: Partial<SavedWindow> = {}): SavedWindow => ({
  projectId,
  assigned: true,
  bounds,
  maximized: false,
  fullscreen: false,
  focused: false,
  ...extra
});
const live = (projectId: string | null, extra: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
  projectId,
  assigned: true,
  bounds,
  maximized: false,
  fullscreen: false,
  focused: false,
  ...extra
});
const screenA = { x: 0, y: 0, width: 1920, height: 1080 };
const screenB = { x: 1920, y: 0, width: 1920, height: 1080 };

describe('snapshotToRecords', () => {
  it('keeps window order, skips windows without a project and duplicates', () => {
    const records = snapshotToRecords([live('a'), live(null), live('b'), live('a')]);
    expect(records.map((r) => r.projectId)).toEqual(['a', 'b']);
  });
});

describe('dedupeByProject', () => {
  it('keeps one window per project and one focused record', () => {
    const result = dedupeByProject([saved('a', { focused: true }), saved('a'), saved('b', { focused: true })]);
    expect(result.map((r) => [r.projectId, r.focused])).toEqual([['a', true], ['b', false]]);
  });
});

describe('parseSavedSession', () => {
  it('drops malformed records and bad bounds', () => {
    const result = parseSavedSession({
      windows: [
        { projectId: 'a', bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: true },
        { projectId: 5 },
        null,
        { projectId: 'b', bounds: { x: 'no' }, assigned: false }
      ]
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ projectId: 'a', maximized: true, assigned: true });
    expect(result[1]).toMatchObject({ projectId: 'b', bounds: null, assigned: false });
  });

  it('returns nothing for junk', () => {
    expect(parseSavedSession(null)).toEqual([]);
    expect(parseSavedSession({ windows: 'x' })).toEqual([]);
  });
});

describe('clampBoundsToDisplays', () => {
  it('keeps bounds that fit a display', () => {
    expect(clampBoundsToDisplays(bounds, [screenA])).toEqual(bounds);
  });

  it('centers a window whose display is gone on the primary display', () => {
    const result = clampBoundsToDisplays({ x: 2500, y: 100, width: 1200, height: 800 }, [screenA]);
    expect(result).toEqual({ x: 360, y: 140, width: 1200, height: 800 });
  });

  it('keeps a window on the secondary display when it exists', () => {
    const onB = { x: 2000, y: 50, width: 1000, height: 700 };
    expect(clampBoundsToDisplays(onB, [screenA, screenB])).toEqual(onB);
  });

  it('shrinks a window larger than the display and pulls it back in', () => {
    const result = clampBoundsToDisplays({ x: 1500, y: 600, width: 3000, height: 2000 }, [screenA]);
    expect(result).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});

describe('planRestore', () => {
  it('skips missing projects and duplicates, keeps order', () => {
    const plan = planRestore(
      [saved('a'), saved('gone'), saved('b'), saved('a')],
      (id) => id !== 'gone',
      [screenA]
    );
    expect(plan.map((p) => p.assignedProjectId)).toEqual(['a', 'b']);
  });

  it('lets only the first unassigned window restore its project from the shared state', () => {
    const plan = planRestore(
      [saved('a', { assigned: false }), saved('b', { assigned: false }), saved('c')],
      () => true,
      [screenA]
    );
    expect(plan.map((p) => p.assignedProjectId)).toEqual([null, 'b', 'c']);
  });

  it('is empty when nothing was saved or every project is gone', () => {
    expect(planRestore([], () => true, [screenA])).toEqual([]);
    expect(planRestore([saved('a')], () => false, [screenA])).toEqual([]);
  });

  it('carries state and clamps bounds', () => {
    const [item] = planRestore(
      [saved('a', { bounds: { x: 5000, y: 0, width: 1000, height: 700 }, maximized: true, focused: true })],
      () => true,
      [screenA]
    );
    expect(item).toMatchObject({ maximized: true, focus: true });
    expect(item.bounds!.x).toBeLessThan(1920);
  });
});

describe('WindowSessionSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(list: () => SavedWindow[]) {
    const write = vi.fn();
    const saver = new WindowSessionSaver({ snapshot: list, write, delayMs: 100 });
    return { saver, write };
  }

  it('does not save before it is enabled', () => {
    const { saver, write } = make(() => [saved('a')]);
    saver.schedule();
    vi.advanceTimersByTime(500);
    expect(write).not.toHaveBeenCalled();
  });

  it('saves once after a burst of changes', () => {
    const { saver, write } = make(() => [saved('a')]);
    saver.enable();
    saver.schedule();
    saver.schedule();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    saver.schedule();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1); // unchanged list is not rewritten
  });

  it('removes a window closed while the app keeps running', () => {
    let list = [saved('a'), saved('b')];
    const { saver, write } = make(() => list);
    saver.enable();
    vi.advanceTimersByTime(100);
    list = [saved('a')];
    saver.schedule();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenLastCalledWith([saved('a')]);
  });

  it('keeps the list when the app quits and its windows close', () => {
    let list = [saved('a'), saved('b')];
    const { saver, write } = make(() => list);
    saver.enable();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    list = [saved('a')];
    saver.schedule(); // a window closes as part of the quit...
    saver.freeze(); // ...after before-quit froze the list
    list = [];
    saver.schedule();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(saver.isFrozen()).toBe(true);
    saver.enable();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
