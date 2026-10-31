/**
 * The usage simulator (Settings > Simulation, development builds only): a pretend date, time of
 * day and 5-hour usage for the previews of the usage popover there. The time is taken twice, in
 * the morning and in the evening (the two rows of previews). Only those previews read them; the
 * real popover always shows the real values.
 */

import { create } from 'zustand';

/** The time slider's step, in minutes */
export const TIME_STEP_MINUTES = 30;
/** The last time the slider reaches, in minutes into the half day (11:30) */
export const TIME_MAX_MINUTES = 12 * 60 - TIME_STEP_MINUTES;

/** Today as an `<input type="date">` value (local) */
function todayValue(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Now, as minutes into its half of the day, down to the slider's step */
function currentHalfDayMinutes(): number {
  const now = new Date();
  const minutes = (now.getHours() % 12) * 60 + now.getMinutes();
  return Math.floor(minutes / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
}

interface UsageSimulatorState {
  /** The pretend day as an `<input type="date">` value (local; today at first), or null for today */
  date: string | null;
  setDate: (value: string | null) => void;
  /** The pretend time as minutes into the half day (0 to 11:30), shown AM and PM */
  minutes: number;
  setMinutes: (value: number) => void;
  /** The pretend 5-hour usage, 0-100 (the real one once known, at first), or null for the real one */
  sessionPercent: number | null;
  setSessionPercent: (value: number | null) => void;
}

export const useUsageSimulatorStore = create<UsageSimulatorState>((set) => ({
  date: todayValue(),
  setDate: (value) => set({ date: value || null }),
  minutes: currentHalfDayMinutes(),
  setMinutes: (value) => set({
    minutes: Number.isNaN(value) ? 0 : Math.min(TIME_MAX_MINUTES, Math.max(0, Math.round(value / TIME_STEP_MINUTES) * TIME_STEP_MINUTES)),
  }),
  sessionPercent: null,
  setSessionPercent: (value) => set({
    sessionPercent: value == null || Number.isNaN(value) ? null : Math.min(100, Math.max(0, value)),
  }),
}));

/**
 * The pretend moment: the day (today when none is set, or an unreadable one) at `minutes` into
 * its morning, or into its evening with `pm`
 */
export function simulatedMoment(date: string | null, minutes: number, pm: boolean): Date {
  const day = date ? new Date(`${date}T00:00`) : new Date();
  const moment = Number.isNaN(day.getTime()) ? new Date() : day;
  moment.setHours(0, minutes + (pm ? 12 * 60 : 0), 0, 0);
  return moment;
}
