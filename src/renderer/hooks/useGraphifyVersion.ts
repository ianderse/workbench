import { useCallback, useEffect, useState } from 'react';
import { readRefreshCache, writeRefreshCache } from '../lib/refresh-cache';
import type { GraphifyVersionInfo } from '../../shared/types/cli';

interface CachedGraphifyVersion {
  info: GraphifyVersionInfo;
  checkedAt: string;
}

const CACHE_KEY = 'graphify-version';

/**
 * The Graphify CLI's installed and latest versions, shared by the Updates page and the Memory
 * page's "Use Graphify" switch. Shows the last check right away and only checks when nothing was
 * checked before; `refresh()` detects the CLI again.
 */
export function useGraphifyVersion() {
  const [state, setState] = useState<CachedGraphifyVersion | null>(
    () => readRefreshCache<CachedGraphifyVersion>(CACHE_KEY) ?? null
  );
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (forceRefresh: boolean) => {
    setIsChecking(true);
    setError(null);
    try {
      const result = await window.electronAPI.checkGraphifyVersion(forceRefresh);
      if (result.success && result.data) {
        const next = { info: result.data, checkedAt: new Date().toISOString() };
        writeRefreshCache(CACHE_KEY, next);
        setState(next);
      } else {
        setError(result.error ?? '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!readRefreshCache<CachedGraphifyVersion>(CACHE_KEY)) void check(false);
  }, [check]);

  return {
    info: state?.info ?? null,
    lastChecked: state ? new Date(state.checkedAt) : null,
    isChecking,
    error,
    /** Detect the CLI again and fetch the latest version */
    refresh: () => check(true),
  };
}
