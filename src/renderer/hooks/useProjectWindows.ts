import { useEffect, useMemo, useState } from 'react';
import type { ProjectWindowInfo } from '../../shared/types';

/** Same ids in the same order (the set only changes when a window opens, closes or switches) */
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function projectIdsOf(windows: ProjectWindowInfo[]): string[] {
  return windows.map((win) => win.projectId).filter((id): id is string => id !== null);
}

export interface ProjectWindows {
  /** Projects that have a window (this window's included) */
  projectIds: ReadonlySet<string>;
  /** How many windows are open; closing the last one would leave the app with none */
  count: number;
}

/**
 * The projects that currently have a window (this window's included).
 *
 * The main process reports the set whenever a window opens, closes or switches project, so
 * project cards can offer "Quit window" and the Projects page can bring an open project's
 * window to the front instead of opening it twice.
 */
export function useProjectWindows(): ProjectWindows {
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    // Replaces the list only on a real change, so other windows' switches don't re-render this one
    const update = (windows: ProjectWindowInfo[]) => {
      const next = projectIdsOf(windows);
      setProjectIds((current) => (sameIds(current, next) ? current : next));
      setCount(windows.length);
    };

    void window.electronAPI
      .listProjectWindows()
      .then((result) => {
        if (active && result.success && result.data) update(result.data);
      })
      .catch((error) => console.warn('[useProjectWindows] Failed to list project windows:', error));

    const stopListening = window.electronAPI.onProjectWindowsChanged(update);
    return () => {
      active = false;
      stopListening();
    };
  }, []);

  return useMemo(() => ({ projectIds: new Set(projectIds), count }), [projectIds, count]);
}

/** Open a project in its own window, or focus the window that already shows it */
export async function openProjectWindow(projectId: string): Promise<void> {
  try {
    const result = await window.electronAPI.openProjectWindow(projectId);
    if (!result.success) {
      console.error('[useProjectWindows] Failed to open the project window:', result.error);
    }
  } catch (error) {
    console.error('[useProjectWindows] Failed to open the project window:', error);
  }
}

/** Close the window showing a project ("Quit window") */
export async function closeProjectWindow(projectId: string): Promise<void> {
  try {
    const result = await window.electronAPI.closeProjectWindow(projectId);
    if (!result.success) {
      console.error('[useProjectWindows] Failed to close the project window:', result.error);
    }
  } catch (error) {
    console.error('[useProjectWindows] Failed to close the project window:', error);
  }
}
