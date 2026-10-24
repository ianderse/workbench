/**
 * Task log watches: the renderer asks for one when it opens a task's logs and drops it when it
 * closes them. A window that is closed with the task dialog still open never sends that unwatch,
 * so the window registry is what releases the watches the closed window held - held by window, not
 * by project, because a window reports whichever project it is showing and reports none while
 * nothing is selected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const windows = vi.hoisted(() => ({
  open: [] as Array<{ windowId: number; projectId: string | null }>,
  listeners: new Set<() => void>(),
}));

vi.mock('../window-manager', () => ({
  listProjectWindows: () => windows.open,
  onProjectWindowsChanged: (listener: () => void) => {
    windows.listeners.add(listener);
    return () => windows.listeners.delete(listener);
  },
}));

vi.mock('../../shared/utils/debug-logger', () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
  debugError: vi.fn(),
}));

import { taskLogService } from '../task-log-service';

const SPEC_ID = '001-task';
const SPECS_REL_PATH = path.join('.workbench', 'tasks');

let project: string;
let specDir: string;
let changed: string[];
const record = (specId: string) => changed.push(specId);

/** A new revision of the task's logs, which the poller sees as a change */
function writeLogs(revision: number): void {
  writeFileSync(
    path.join(specDir, 'task_logs.json'),
    JSON.stringify({ spec_id: SPEC_ID, created_at: '', updated_at: `rev-${revision}`, phases: {} })
  );
}

/** The window registry reports a change (a window opened, closed or switched project) */
function windowsChanged(): void {
  for (const listener of [...windows.listeners]) listener();
}

beforeEach(() => {
  vi.useFakeTimers();
  project = mkdtempSync(path.join(os.tmpdir(), 'task-logs-'));
  specDir = path.join(project, SPECS_REL_PATH, SPEC_ID);
  mkdirSync(specDir, { recursive: true });
  changed = [];
  windows.open = [{ windowId: 1, projectId: 'project-1' }];
  taskLogService.on('logs-changed', record);
});

afterEach(() => {
  taskLogService.off('logs-changed', record);
  taskLogService.stopAllWatching();
  taskLogService.clearCache(specDir);
  vi.useRealTimers();
  rmSync(project, { recursive: true, force: true });
});

describe('task log watches', () => {
  it('stops polling when the window that asked for the watch is gone', () => {
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);

    // The window closes with the task dialog open, so no unwatch ever arrives
    windows.open = [];
    windowsChanged();

    writeLogs(2);
    vi.advanceTimersByTime(5000);
    expect(changed).toEqual([SPEC_ID]);
  });

  it('keeps the watch while another window still holds it', () => {
    windows.open = [
      { windowId: 1, projectId: 'project-1' },
      { windowId: 2, projectId: 'project-1' },
    ];
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 2);

    windows.open = [{ windowId: 2, projectId: 'project-1' }];
    windowsChanged();

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * What a window reports is the project it is showing: it reports none while nothing is selected,
   * and a different one as the user switches tabs. Releasing on that would cut the log stream of a
   * task dialog that is still open in that very window, and the renderer only subscribes when it
   * mounts, so the stream would never come back.
   */
  it('keeps the watch when the window that holds it reports another project, or none', () => {
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);

    windows.open = [{ windowId: 1, projectId: 'project-2' }];
    windowsChanged();
    windows.open = [{ windowId: 1, projectId: null }];
    windowsChanged();

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * The renderer unwatches as its task dialog unmounts, and by then its window may be too far gone
   * to read from the IPC event. Such an unwatch drops nothing, because the view it belongs to is
   * recorded under that window - the registry releases it when the window leaves, which is the
   * signal that actually knows the window is going.
   */
  /**
   * The registry subscription exists to release the watches of windows that are gone. With nothing
   * watched there is nothing to release, so staying subscribed would mean every window opening,
   * closing or switching project walked an empty set for the rest of the session - from the first
   * task dialog the user closes onwards.
   */
  it('stops listening to the window registry once nothing is watched', () => {
    expect(windows.listeners.size).toBe(0);

    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);
    expect(windows.listeners.size).toBe(1);

    taskLogService.stopWatching(specDir, 1);
    expect(windows.listeners.size).toBe(0);

    // And it subscribes again for the next dialog
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);
    expect(windows.listeners.size).toBe(1);
  });

  /**
   * An entry can hold an unattributed view beside a named one. The unattributed view keeps the
   * entry alive, because nothing here can say whether the window behind it still shows the task -
   * but the window beside it closing should still take its own view with it, or the entry goes on
   * standing in for a view nobody holds.
   */
  it('drops a closed window\'s view even while an unattributed one keeps the watch', () => {
    windows.open = [{ windowId: 4, projectId: 'project-1' }];
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1');
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 4);

    windows.open = [];
    windowsChanged();

    // Still polling: the unattributed view is only ever released by an unwatch
    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);

    // And that one unwatch is enough, because window 4's view went with the window
    taskLogService.stopWatching(specDir, undefined);
    writeLogs(2);
    vi.advanceTimersByTime(5000);
    expect(changed).toEqual([SPEC_ID]);
  });

  it('leaves an unwatch it cannot attribute to the registry', () => {
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);

    taskLogService.stopWatching(specDir, undefined);
    writeLogs(1);
    vi.advanceTimersByTime(1000);
    // Still polling: nothing yet says this window is done with the task
    expect(changed).toEqual([SPEC_ID]);

    windows.open = [];
    windowsChanged();
    writeLogs(2);
    vi.advanceTimersByTime(5000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * Two windows, and the one that closes loses its window id before it unwatches. Reading that as
   * "the last view is going" would stop the other window's poller for good, since its renderer
   * subscribed when it mounted and never subscribes again.
   */
  /**
   * Two projects can hold a task of the same spec id, each with its own spec directory. Starting a
   * watch drops this project's stale pollers for that spec - a project whose paths changed leaves
   * one nothing can unwatch - but it must not touch the other project's live one, whose dialog
   * subscribed when it mounted and would never subscribe again.
   */
  it('leaves another project watching the same spec id when a watch starts', () => {
    const otherSpecDir = path.join(project, 'other', SPECS_REL_PATH, SPEC_ID);
    mkdirSync(otherSpecDir, { recursive: true });
    writeFileSync(
      path.join(otherSpecDir, 'task_logs.json'),
      JSON.stringify({ spec_id: SPEC_ID, created_at: '', updated_at: 'other-1', phases: {} })
    );

    windows.open = [
      { windowId: 1, projectId: 'project-1' },
      { windowId: 2, projectId: 'project-2' },
    ];
    taskLogService.startWatching(SPEC_ID, otherSpecDir, project, SPECS_REL_PATH, 'project-2', 2);
    // The same spec id, in another project, with its own directory
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);

    writeFileSync(
      path.join(otherSpecDir, 'task_logs.json'),
      JSON.stringify({ spec_id: SPEC_ID, created_at: '', updated_at: 'other-2', phases: {} })
    );
    writeLogs(1);
    vi.advanceTimersByTime(1000);

    // Both pollers are alive: one event from each project's spec directory
    expect(changed).toEqual([SPEC_ID, SPEC_ID]);
  });

  it('keeps the other window polling when a closing window unwatches without naming itself', () => {
    windows.open = [
      { windowId: 5, projectId: 'project-1' },
      { windowId: 7, projectId: 'project-1' },
    ];
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 5);
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 7);

    // Window 7 closes: the registry releases its view, leaving window 5's
    windows.open = [{ windowId: 5, projectId: 'project-1' }];
    windowsChanged();
    // Its renderer then unmounts, by which point its window cannot be read from the event
    taskLogService.stopWatching(specDir, undefined);

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);
  });

  it('leaves a second window watching when one unwatch cannot be attributed', () => {
    windows.open = [
      { windowId: 1, projectId: 'project-1' },
      { windowId: 2, projectId: 'project-1' },
    ];
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 2);

    // Two views are open, so an unwatch that names neither of them cannot end the poller
    taskLogService.stopWatching(specDir, undefined);

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * The window that asked for the watch could not be read then and can be read now, so its
   * unwatch names an id the viewer set never held. The view it is giving up is the unattributed
   * one, and since the registry leaves unattributed views alone, nothing else would ever reclaim
   * the poller.
   */
  it('releases a watch taken without a window when its unwatch names one', () => {
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1');

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);

    taskLogService.stopWatching(specDir, 1);

    writeLogs(2);
    vi.advanceTimersByTime(5000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * An unwatch that matches nothing while a named window's view is also in the set says nothing
   * about the unattributed one: the view it owns may be that window's own, so the unattributed view
   * stays and keeps polling for the window behind it after the named window has gone too.
   */
  it('keeps the unattributed view when an unmatched unwatch arrives beside a named one', () => {
    windows.open = [
      { windowId: 1, projectId: 'project-1' },
      { windowId: 2, projectId: 'project-1' },
    ];
    // Window 1's watch could not be attributed; window 2's could
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1');
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 2);

    // Names a window that holds no view: the only thing it can mean is window 1's unattributed
    // view, which two views in the set cannot confirm
    taskLogService.stopWatching(specDir, 3);
    taskLogService.stopWatching(specDir, 2);

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * One window can hold two views of the same task's logs (two dialogs, or one reopened before its
   * unwatch landed). Both are recorded under the same window, so they have to be counted: the
   * first unwatch must leave the second view's stream alone.
   */
  it('keeps polling until both views one window holds have unwatched', () => {
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 1);

    taskLogService.stopWatching(specDir, 1);
    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);

    taskLogService.stopWatching(specDir, 1);
    writeLogs(2);
    vi.advanceTimersByTime(5000);
    expect(changed).toEqual([SPEC_ID]);
  });

  /**
   * Window 1's watch could not be attributed and window 2's could, and then window 2 unwatches
   * without naming itself. Reading that as the unattributed view going takes window 1's view away,
   * and the registry releasing window 2's view afterwards then finds the entry empty - so window 1
   * is left with a task dialog open and no log stream, which it cannot ask for again.
   */
  it('keeps a window\'s unattributed view when another window unwatches without naming itself', () => {
    windows.open = [
      { windowId: 1, projectId: 'project-1' },
      { windowId: 2, projectId: 'project-1' },
    ];
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1');
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1', 2);

    taskLogService.stopWatching(specDir, undefined);
    windows.open = [{ windowId: 1, projectId: 'project-1' }];
    windowsChanged();

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);
  });

  it('leaves a watch it could not attribute to a window to its own unwatch', () => {
    // No window id reached the service (a sender already tearing down), so the registry must not
    // decide its fate
    taskLogService.startWatching(SPEC_ID, specDir, project, SPECS_REL_PATH, 'project-1');

    windows.open = [];
    windowsChanged();

    writeLogs(1);
    vi.advanceTimersByTime(1000);
    expect(changed).toEqual([SPEC_ID]);

    taskLogService.stopWatching(specDir);
    writeLogs(2);
    vi.advanceTimersByTime(5000);
    expect(changed).toEqual([SPEC_ID]);
  });
});
