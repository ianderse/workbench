import { create } from 'zustand';

/**
 * Projects whose queued tasks are held back by a higher-priority project that has work to run
 * (project id -> the blocking project's name). Filled from the main process: one fetch at
 * start and a `queue-hold` event on every change.
 */
interface QueueHoldState {
  holds: Record<string, string>;
  setHold: (projectId: string, blockedByName: string | null) => void;
  setHolds: (holds: Array<{ projectId: string; blockedBy: { name: string } }>) => void;
}

export const useQueueHoldStore = create<QueueHoldState>((set) => ({
  holds: {},
  setHold: (projectId, blockedByName) =>
    set((state) => {
      if ((state.holds[projectId] ?? null) === blockedByName) return state;
      const holds = { ...state.holds };
      if (blockedByName) holds[projectId] = blockedByName;
      else delete holds[projectId];
      return { holds };
    }),
  setHolds: (list) => set({ holds: Object.fromEntries(list.map((h) => [h.projectId, h.blockedBy.name])) }),
}));
