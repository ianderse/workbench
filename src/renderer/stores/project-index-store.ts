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
  /**
   * Give the project a CLAUDE.md only when it has none, which is what switching Use CLAUDE.md on
   * does. The main process hands back the file that switching off set aside, when there is one,
   * so this writes a new one only for a project that has nothing waiting.
   */
  buildIfMissing: (projectId: string) => Promise<void>;
  /**
   * Move the project's CLAUDE.md aside, which is what switching Use CLAUDE.md off does.
   * False when it is still in the project folder, so the switch can stay on.
   */
  remove: (projectId: string) => Promise<boolean>;
}

/**
 * The project index (Settings > Project): the project's CLAUDE.md, written by a short Claude Code
 * run of `/init` and moved aside when the project stops using it. The run reads the whole
 * codebase, so it takes a while and the Use CLAUDE.md switch waits for it.
 */
export const useProjectIndexStore = create<ProjectIndexState>((set, get) => {
  const runBuild = async (projectId: string, restore = false) => {
    set((state) => ({
      building: { ...state.building, [projectId]: true },
      buildError: { ...state.buildError, [projectId]: null },
    }));
    let error: string | null = null;
    let index: ProjectIndexInfo | null = get().index[projectId] ?? null;
    try {
      const result = await window.electronAPI.buildProjectIndex(projectId, restore);
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
      // Rebuild asks for a fresh read of the codebase, so it never hands back the file switching
      // the index off set aside - that would report an old CLAUDE.md as a successful rebuild
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
      // Switching the index on is the one request that means "give the project the CLAUDE.md it
      // had", so the file set aside comes back rather than a regenerated one
      await runBuild(projectId, true);
    },

    remove: async (projectId) => {
      const result = await window.electronAPI.stashProjectIndex(projectId).catch(() => null);
      if (!result?.success) {
        // The file is still there, so say so rather than showing the switch as off
        await get().refresh(projectId);
        return false;
      }
      set((state) => ({
        index: { ...state.index, [projectId]: null },
        buildError: { ...state.buildError, [projectId]: null },
      }));
      return true;
    },
  };
});
