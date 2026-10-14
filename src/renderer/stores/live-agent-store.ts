import { create } from 'zustand';

interface LiveAgentState {
  /** Whether each project has Live agent on (its .auto-claude/flow directory exists), by project path */
  enabled: Record<string, boolean>;
  /** Why the project's Claude Code hooks couldn't be set up when Live agent was last switched on */
  hooksError: Record<string, string | undefined>;
  /** Read the project's setting, once (later reads use the stored value) */
  load: (projectPath: string) => Promise<void>;
  /** Switch Live agent on or off for the project; resolves to an error message if it failed */
  setEnabled: (projectPath: string, enabled: boolean) => Promise<string | undefined>;
}

/** Each project's "Live agent" setting, for Settings > Claude Code and the agent windows */
export const useLiveAgentStore = create<LiveAgentState>((set, get) => {
  const loading = new Set<string>();
  return {
    enabled: {},
    hooksError: {},
    load: async (projectPath) => {
      if (projectPath in get().enabled || loading.has(projectPath)) return;
      loading.add(projectPath);
      try {
        const result = await window.electronAPI.getLiveAgentProject(projectPath);
        const value = result.success && result.data === true;
        // A switch made meanwhile is newer
        if (!(projectPath in get().enabled)) set((state) => ({ enabled: { ...state.enabled, [projectPath]: value } }));
      } catch {
        // Unknown: read again next time
      } finally {
        loading.delete(projectPath);
      }
    },
    setEnabled: async (projectPath, enabled) => {
      try {
        const result = await window.electronAPI.setLiveAgentProject(projectPath, enabled);
        if (!result.success) return result.error ?? 'Failed';
        set((state) => ({
          enabled: { ...state.enabled, [projectPath]: enabled },
          hooksError: { ...state.hooksError, [projectPath]: result.data?.hooksError },
        }));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
});
