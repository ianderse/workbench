import { create } from 'zustand';
import { queueHoldKey, type QueueHold, type QueueHoldsSnapshot } from '../../shared/utils/project-priority';

/**
 * Why queued tasks wait (project id -> hold: no free slot, a higher-priority project goes first,
 * or the project's own cap) and how many tasks run in each project (all projects share one model
 * server). Filled from the main process: one fetch at start and an event on every change.
 * Selectors must return strings or numbers, not fresh objects.
 */
interface QueueHoldState {
  holds: Record<string, QueueHold>;
  /** Running tasks (in progress + AI review) per project, projects without any left out */
  running: Record<string, number>;
  setHold: (projectId: string, hold: QueueHold | null) => void;
  setRunning: (running: Record<string, number>) => void;
  setSnapshot: (snapshot: QueueHoldsSnapshot) => void;
}

export const useQueueHoldStore = create<QueueHoldState>((set) => ({
  holds: {},
  running: {},
  setHold: (projectId, hold) =>
    set((state) => {
      if (queueHoldKey(state.holds[projectId]) === queueHoldKey(hold)) return state;
      const holds = { ...state.holds };
      if (hold) holds[projectId] = hold;
      else delete holds[projectId];
      return { holds };
    }),
  setRunning: (running) => set({ running }),
  setSnapshot: (snapshot) =>
    set({
      holds: Object.fromEntries(snapshot.holds.map((h) => [h.projectId, h.hold])),
      running: snapshot.running,
    }),
}));

/** Tasks running in other projects than `projectId` */
export function selectOtherProjectsRunning(running: Record<string, number>, projectId: string | undefined): number {
  let total = 0;
  for (const [id, count] of Object.entries(running)) if (id !== projectId) total += count;
  return total;
}
