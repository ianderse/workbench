import { create } from 'zustand';
import type { ProjectIndexInfo } from '../../shared/types/cli';

interface ProjectIndexState {
  /** The project's CLAUDE.md stats, by project id (null once checked and the project has none) */
  index: Record<string, ProjectIndexInfo | null>;
  /** Whether a build is running, by project id */
  building: Record<string, boolean>;
  /** The last build's error by project id ('' when it failed without a message), null when it worked */
  buildError: Record<string, string | null>;
  /** Read the project's CLAUDE.md stats, and whether a build is already running in the main process */
  refresh: (projectId: string) => Promise<void>;
  /** Write (or rewrite) the project's CLAUDE.md */
  build: (projectId: string) => Promise<void>;
  /** Write it only when the project has none, which is what switching Use CLAUDE.md on does */
  buildIfMissing: (projectId: string) => Promise<void>;
  /** Remove the project's CLAUDE.md, which is what switching Use CLAUDE.md off does */
  remove: (projectId: string) => Promise<void>;
}

/**
 * The project index (Settings > Project): the project's CLAUDE.md, written by a short Claude Code
 * run of `/init` and removed when the project stops using it. The run reads the whole codebase, so
 * it takes a while and the Use CLAUDE.md switch waits for it.
 */
export const useProjectIndexStore = create<ProjectIndexState>((set, get) => {
  const runBuild = async (projectId: string) => {
    set((state) => ({
      building: { ...state.building, [projectId]: true },
      buildError: { ...state.buildError, [projectId]: null },
    }));
    let error: string | null = null;
    let index: ProjectIndexInfo | null = get().index[projectId] ?? null;
    try {
      const result = await window.electronAPI.buildProjectIndex(projectId);
      if (result.success && result.data) index = result.data;
      else error = result.error ?? '';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    set((state) => ({
      building: { ...state.building, [projectId]: false },
      buildError: { ...state.buildError, [projectId]: error },
      index: { ...state.index, [projectId]: index },
    }));
  };

  return {
    index: {},
    building: {},
    buildError: {},

    refresh: async (projectId) => {
      const [index, building] = await Promise.all([
        window.electronAPI.getProjectIndex(projectId).then(
          (result) => (result.success ? result.data ?? null : null),
          () => null
        ),
        window.electronAPI.isProjectIndexBuilding(projectId).then(
          (result) => result.success && result.data === true,
          () => false
        ),
      ]);
      set((state) => ({
        index: { ...state.index, [projectId]: index },
        building: { ...state.building, [projectId]: building },
      }));
    },

    build: async (projectId) => {
      if (get().building[projectId]) return;
      await runBuild(projectId);
    },

    buildIfMissing: async (projectId) => {
      if (get().building[projectId]) return;
      const existing = await window.electronAPI.getProjectIndex(projectId).then(
        (result) => (result.success ? result.data ?? null : null),
        () => null
      );
      if (existing) {
        set((state) => ({ index: { ...state.index, [projectId]: existing } }));
        return;
      }
      await runBuild(projectId);
    },

    remove: async (projectId) => {
      const result = await window.electronAPI.deleteProjectIndex(projectId).catch(() => null);
      if (!result?.success) {
        // The file is still there, so say so rather than showing the switch as off
        await get().refresh(projectId);
        return;
      }
      set((state) => ({
        index: { ...state.index, [projectId]: null },
        buildError: { ...state.buildError, [projectId]: null },
      }));
    },
  };
});
