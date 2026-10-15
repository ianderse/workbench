import { create } from 'zustand';

interface MemoryGraphState {
  /** Whether each project has a memory graph (.workbench/knowledge), by project id */
  available: Record<string, boolean>;
  /** Whether each project uses Graphify (its .workbench/knowledge folder exists), by project id */
  enabled: Record<string, boolean>;
  /** Bumped when a project's graph is rebuilt, so an open graph view reloads it */
  revision: Record<string, number>;
  /** Whether a build started from the app (Knowledge index, Use Graphify) is running, by project id */
  building: Record<string, boolean>;
  /** The last such build's error by project id ('' when it failed without a message), null when it worked */
  buildError: Record<string, string | null>;
  /** Check whether the project uses Graphify and has a memory graph */
  refresh: (projectId: string) => Promise<void>;
  /**
   * Switch the project's Use Graphify on (creates .workbench/knowledge and builds the graph) or
   * off (removes .workbench/knowledge with the graph)
   */
  setEnabled: (projectId: string, enabled: boolean) => Promise<void>;
  /** Build (or rebuild) the project's memory graph */
  build: (projectId: string) => Promise<void>;
  /** The project's graph was just (re)built */
  markRebuilt: (projectId: string) => void;
}

/** Which projects use Graphify and have a memory graph, for the sidebar's Memory item and the graph view */
export const useMemoryGraphStore = create<MemoryGraphState>((set, get) => {
  // Graphs rebuilt in the background (after a task completed) show up and reload like a manual build
  window.electronAPI?.onGraphifyIndexUpdated?.((projectId) => get().markRebuilt(projectId));

  /** Build the project's graph (marked as building already) and record how it went */
  const runBuild = async (projectId: string) => {
    let error: string | null = null;
    try {
      const result = await window.electronAPI.buildGraphifyIndex(projectId);
      if (result.success && result.data) {
        // Shows the sidebar's Memory item and reloads an open graph view
        get().markRebuilt(projectId);
      } else {
        error = result.error ?? '';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    set((state) => ({
      building: { ...state.building, [projectId]: false },
      buildError: { ...state.buildError, [projectId]: error },
    }));
  };

  return {
    available: {},
    enabled: {},
    revision: {},
    building: {},
    buildError: {},
    refresh: async (projectId) => {
      const [has, enabled] = await Promise.all([
        window.electronAPI.hasGraphifyGraph(projectId).then((result) => result.success && result.data === true, () => false),
        window.electronAPI.isGraphifyEnabled(projectId).then((result) => result.success && result.data === true, () => false),
      ]);
      set((state) => ({
        available: { ...state.available, [projectId]: has },
        enabled: { ...state.enabled, [projectId]: enabled },
      }));
    },
    setEnabled: async (projectId, enabled) => {
      // Switching off hides the Memory item right away; the folder is removed meanwhile. Switching
      // on counts as building from the start, so the switch waits for the build
      set((state) => ({
        enabled: { ...state.enabled, [projectId]: enabled },
        buildError: { ...state.buildError, [projectId]: null },
        ...(enabled
          ? { building: { ...state.building, [projectId]: true } }
          : { available: { ...state.available, [projectId]: false } }),
      }));
      const result = await window.electronAPI.setGraphifyEnabled(projectId, enabled).catch(() => null);
      if (!result?.success) {
        set((state) => ({ building: { ...state.building, [projectId]: false } }));
        await get().refresh(projectId);
        return;
      }
      if (enabled) await runBuild(projectId);
    },
    build: async (projectId) => {
      if (get().building[projectId]) return;
      set((state) => ({
        building: { ...state.building, [projectId]: true },
        buildError: { ...state.buildError, [projectId]: null },
      }));
      await runBuild(projectId);
    },
    markRebuilt: (projectId) =>
      set((state) => ({
        available: { ...state.available, [projectId]: true },
        enabled: { ...state.enabled, [projectId]: true },
        revision: { ...state.revision, [projectId]: (state.revision[projectId] ?? 0) + 1 },
      })),
  };
});
