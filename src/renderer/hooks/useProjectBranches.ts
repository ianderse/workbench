import { useCallback, useEffect, useState } from 'react';
import { readRefreshCache, writeRefreshCache } from '../lib/refresh-cache';
import type { GitBranchDetail } from '../../shared/types';

interface CachedBranches {
  branches: GitBranchDetail[];
  /** The repository's default branch (origin HEAD, main or master) */
  detected: string;
}

const cacheKey = (projectPath: string) => `branches:${projectPath}`;

/**
 * A project's branches, shared by the branch pickers (project settings, task, worktree and PR
 * dialogs). Shows the last listed branches right away and lists them again in the background
 * (local refs only, no network), so branches made outside the app show up; `refresh()` also
 * fetches remote refs (git fetch) and updates every picker.
 */
export function useProjectBranches(projectPath: string | null | undefined) {
  const [state, setState] = useState<CachedBranches | null>(() =>
    projectPath ? readRefreshCache<CachedBranches>(cacheKey(projectPath)) ?? null : null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // quiet: update a shown list without the loading state (pickers stay usable)
  const load = useCallback(async (fetchRemote: boolean, quiet = false): Promise<CachedBranches | null> => {
    if (!projectPath) return null;
    if (!quiet) setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getGitBranchesWithInfo(projectPath, fetchRemote);
      if (!result.success || !result.data) {
        // Empty string: failed without a message
        setError(result.error ?? '');
        return null;
      }
      const detectResult = await window.electronAPI.detectMainBranch(projectPath);
      const next = { branches: result.data, detected: detectResult.success && detectResult.data ? detectResult.data : '' };
      writeRefreshCache(cacheKey(projectPath), next);
      setState(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (!quiet) setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setState(null);
      return;
    }
    const cached = readRefreshCache<CachedBranches>(cacheKey(projectPath));
    setState(cached ?? null);
    void load(false, !!cached);
  }, [projectPath, load]);

  return {
    branches: state?.branches ?? [],
    detectedBranch: state?.detected ?? '',
    isLoading,
    error,
    /** Fetch remote refs and list branches again */
    refresh: () => load(true),
  };
}
