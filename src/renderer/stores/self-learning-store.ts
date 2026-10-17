import { create } from 'zustand';
import type { SelfLearningIndexInfo } from '../../shared/types/cli';

interface SelfLearningState {
  /** The project's memory index stats, by project id (null once checked and never built) */
  index: Record<string, SelfLearningIndexInfo | null>;
  /** Whether a build is running, by project id */
  building: Record<string, boolean>;
  /** The last build's error by project id ('' when it failed without a message), null when it worked */
  buildError: Record<string, string | null>;
  /** Read the project's index stats, and whether a build is already running in the main process */
  refresh: (projectId: string) => Promise<void>;
  /** Build (or rebuild) the project's memories from its past sessions */
  build: (projectId: string) => Promise<void>;
  /** Build only when the project has no memories yet, which is what switching the feature on does */
  buildIfEmpty: (projectId: string) => Promise<void>;
}

/**
 * The project's memory index (Settings > Project > Knowledge): the memories built from the sessions
 * the project already had. Builds read every past transcript, so they take a while and the
 * Self-learning switch waits for them.
 */
export const useSelfLearningStore = create<SelfLearningState>((set, get) => {
  const runBuild = async (projectId: string) => {
    set((state) => ({ building: { ...state.building, [projectId]: true } }));
    let error: string | null = null;
    let index: SelfLearningIndexInfo | null = get().index[projectId] ?? null;
    try {
      const result = await window.electronAPI.buildMemoryIndex(projectId);
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
        window.electronAPI.getMemoryIndex(projectId).then(
          (result) => (result.success ? result.data ?? null : null),
          () => null
        ),
        window.electronAPI.isMemoryIndexBuilding(projectId).then(
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

    buildIfEmpty: async (projectId) => {
      if (get().building[projectId]) return;
      const existing = await window.electronAPI.getMemoryIndex(projectId).then(
        (result) => (result.success ? result.data ?? null : null),
        () => null
      );
      if (existing && existing.memories > 0) {
        set((state) => ({ index: { ...state.index, [projectId]: existing } }));
        return;
      }
      await runBuild(projectId);
    },
  };
});
