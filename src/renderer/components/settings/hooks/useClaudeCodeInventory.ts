import { useCallback, useEffect, useState } from 'react';
import { readRefreshCache, writeRefreshCache } from '../../../lib/refresh-cache';
import type { ClaudeCodeInventory } from '../../../../shared/types/claude-code';

interface CachedInventory {
  inventory: ClaudeCodeInventory;
  /** ISO time of the scan */
  checkedAt: string;
}

const cacheKey = (projectPath: string) => `claude-code-inventory:${projectPath}`;

/**
 * What Claude Code loads when it runs in a project (subagents, skills, commands, hooks, MCP
 * servers, CLAUDE.md and settings files). Shows the last scan right away and only scans when
 * the project was never scanned before; `refresh()` scans again.
 */
export function useClaudeCodeInventory(projectPath: string | null | undefined) {
  const [state, setState] = useState<CachedInventory | null>(() =>
    projectPath ? readRefreshCache<CachedInventory>(cacheKey(projectPath)) ?? null : null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getClaudeCodeInventory(projectPath);
      if (!result.success || !result.data) {
        setError(result.error ?? '');
        return;
      }
      const next = { inventory: result.data, checkedAt: new Date().toISOString() };
      writeRefreshCache(cacheKey(projectPath), next);
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setState(null);
      return;
    }
    const cached = readRefreshCache<CachedInventory>(cacheKey(projectPath));
    setState(cached ?? null);
    setError(null);
    if (!cached) void load();
  }, [projectPath, load]);

  return {
    inventory: state?.inventory ?? null,
    checkedAt: state?.checkedAt ? new Date(state.checkedAt) : null,
    isLoading,
    error,
    refresh: load,
  };
}
