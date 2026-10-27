import { create } from 'zustand';
import type { MemoryContextPacket, ProjectMemory } from '../../shared/types/project-memory';

interface MemoryState {
  /** A new preload/renderer can be loaded while the older main process still owns live workers. */
  requiresRestart: boolean;
  entries: Record<string, ProjectMemory[] | undefined>;
  contexts: Record<string, MemoryContextPacket[] | undefined>;
  refresh: (projectId: string) => Promise<void>;
  refreshContext: (projectId: string, taskId: string) => Promise<void>;
}

/** Small disk records are loaded once, then only on Refresh or after a mutation. */
export const useProjectMemoryStore = create<MemoryState>((set) => ({
  entries: {}, contexts: {}, requiresRestart: false,
  refresh: async (projectId) => {
    const result = await window.electronAPI.listProjectMemories(projectId).catch((error: unknown) => {
      if (/No handler registered for ['"]projectMemory:/.test(String(error))) set({ requiresRestart: true });
      throw error;
    });
    if (!result.success || !result.data) throw new Error(result.error || 'Memory could not be loaded');
    set((state) => ({ requiresRestart: false, entries: { ...state.entries, [projectId]: result.data } }));
  },
  refreshContext: async (projectId, taskId) => {
    const result = await window.electronAPI.getTaskMemoryContext(projectId, taskId).catch((error: unknown) => {
      if (/No handler registered for ['"]projectMemory:/.test(String(error))) set({ requiresRestart: true });
      throw error;
    });
    if (!result.success || !result.data) throw new Error(result.error || 'Memory context could not be loaded');
    set((state) => ({ requiresRestart: false, contexts: { ...state.contexts, [`${projectId}:${taskId}`]: result.data } }));
  },
}));
