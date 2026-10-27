/**
 * The usage simulator (Settings > Developer, development builds only): a pretend date and time
 * and 5-hour usage for the preview of the usage popover there. Only that preview reads them; the
 * real popover always shows the real values.
 */

import { create } from 'zustand';

interface UsageSimulatorState {
  /** The pretend moment as an `<input type="datetime-local">` value (local time), or null for now */
  clock: string | null;
  setClock: (value: string | null) => void;
  /** The pretend 5-hour usage, 0-100, or null for the real one */
  sessionPercent: number | null;
  setSessionPercent: (value: number | null) => void;
}

export const useUsageSimulatorStore = create<UsageSimulatorState>((set) => ({
  clock: null,
  setClock: (value) => set({ clock: value || null }),
  sessionPercent: null,
  setSessionPercent: (value) => set({
    sessionPercent: value == null || Number.isNaN(value) ? null : Math.min(100, Math.max(0, value)),
  }),
}));

/** The pretend moment as a Date, or null when none (or an unreadable one) is set */
export function simulatedMoment(clock: string | null): Date | null {
  if (!clock) return null;
  const date = new Date(clock);
  return Number.isNaN(date.getTime()) ? null : date;
}
