/**
 * The latest usage snapshot the sidebar's usage badge received, kept so other views (the usage
 * simulator's preview) can show it without asking for it again.
 */

import { create } from 'zustand';
import type { ClaudeUsageSnapshot } from '../../shared/types/agent';

interface UsageState {
  usage: ClaudeUsageSnapshot | null;
  setUsage: (usage: ClaudeUsageSnapshot | null) => void;
}

export const useUsageStore = create<UsageState>((set) => ({
  usage: null,
  setUsage: (usage) => set({ usage }),
}));
