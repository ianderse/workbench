import { create } from 'zustand';

interface MemoryGraphState {
  /** Whether each project has a memory graph (.workbench/knowledge), by project id */
  available: Record<string, boolean>;
  /** Bumped when a project's graph is rebuilt, so an open graph view reloads it */
  revision: Record<string, number>;
  /** Check whether the project has a memory graph */
  refresh: (projectId: string) => Promise<void>;
  /** The project's graph was just (re)built */
  markRebuilt: (projectId: string) => void;
}

/** Which projects have a memory graph, for the sidebar's Memory item and the graph view */
export const useMemoryGraphStore = create<MemoryGraphState>((set, get) => {
  // Graphs rebuilt in the background (after a task completed) show up and reload like a manual build
  window.electronAPI?.onGraphifyIndexUpdated?.((projectId) => get().markRebuilt(projectId));
  return {
    available: {},
    revision: {},
    refresh: async (projectId) => {
      try {
        const result = await window.electronAPI.hasGraphifyGraph(projectId);
        const has = result.success && result.data === true;
        set((state) => ({ available: { ...state.available, [projectId]: has } }));
      } catch {
        set((state) => ({ available: { ...state.available, [projectId]: false } }));
      }
    },
    markRebuilt: (projectId) =>
      set((state) => ({
        available: { ...state.available, [projectId]: true },
        revision: { ...state.revision, [projectId]: (state.revision[projectId] ?? 0) + 1 },
      })),
  };
});
