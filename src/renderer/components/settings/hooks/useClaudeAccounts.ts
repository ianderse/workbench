import { useCallback, useEffect, useState } from 'react';
import { loadClaudeProfiles, useClaudeProfileStore } from '../../../stores/claude-profile-store';
import type { ProfileUsageSummary } from '../../../../shared/types';

/**
 * Claude accounts (subscription profiles Claude Code signs in with) and their latest usage.
 * Loads the profiles and the cached usage once when `enabled`; usage then updates from the
 * main process' usage pushes.
 */
export function useClaudeAccounts(enabled = true) {
  const profiles = useClaudeProfileStore((state) => state.profiles);
  const activeProfileId = useClaudeProfileStore((state) => state.activeProfileId);
  const isLoading = useClaudeProfileStore((state) => state.isLoading);
  const [usage, setUsage] = useState<Map<string, ProfileUsageSummary>>(new Map());

  const toUsageMap = (all: ProfileUsageSummary[]) =>
    new Map(all.map((summary) => [summary.profileId, summary] as const));

  const loadUsage = useCallback(async (forceRefresh = false) => {
    try {
      const result = await window.electronAPI.requestAllProfilesUsage?.(forceRefresh);
      if (result?.success && result.data) setUsage(toUsageMap(result.data.allProfiles));
    } catch {
      // Usage is optional; it arrives with the next update
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void loadClaudeProfiles();
    void loadUsage(false);
  }, [enabled, loadUsage]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onAllProfilesUsageUpdated?.((all) => {
      setUsage(toUsageMap(all.allProfiles));
    });
    return () => { unsubscribe?.(); };
  }, []);

  /** Reload the profiles (after adding, renaming, removing or signing in) and their usage */
  const reload = useCallback(async () => {
    await loadClaudeProfiles();
    await loadUsage(true);
  }, [loadUsage]);

  return { profiles, activeProfileId, isLoading, usage, reload };
}
