/**
 * Metrics (Settings > Accounts): spending per project, the sum of every task's Claude Code run
 * cost in each registered project with an initialized `.workbench` directory. Shows the last
 * result (refresh cache) and only reads the projects again on Refresh, or once when nothing was
 * read before.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { formatRelativeTime } from '../../lib/utils';
import { formatCostUsd } from '../../../shared/utils/claude-run';
import type { ProjectCostMetrics } from '../../../shared/types';

const CACHE_KEY = 'project-cost-metrics';

interface CachedMetrics {
  projects: ProjectCostMetrics[];
  checkedAt: string;
}

export function ProjectMetricsSection() {
  const { t } = useTranslation('settings');
  const [metrics, setMetrics] = useState<CachedMetrics | undefined>(() => readRefreshCache<CachedMetrics>(CACHE_KEY));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getProjectCostMetrics();
      if (result.success && result.data) {
        const next = { projects: result.data, checkedAt: new Date().toISOString() };
        setMetrics(next);
        writeRefreshCache(CACHE_KEY, next);
      } else {
        setError(result.error || t('accounts.metrics.error'));
      }
    } catch {
      setError(t('accounts.metrics.error'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // Read once when nothing was read before; afterwards only on Refresh
  useEffect(() => {
    if (!readRefreshCache<CachedMetrics>(CACHE_KEY)) void refresh();
  }, [refresh]);

  const projects = metrics?.projects ?? [];
  const total = projects.reduce((sum, project) => sum + project.totalCostUsd, 0);

  return (
    <SettingsSection title={t('accounts.metrics.title')}>
      <SettingsRows>
        {projects.map((project) => (
          <SettingsRow
            key={project.projectId}
            label={project.name}
            description={
              <span className="break-all" title={project.path}>
                {project.path} · {t('accounts.metrics.tasks', { count: project.taskCount })}
              </span>
            }
          >
            <span className="text-sm tabular-nums text-foreground">{formatCostUsd(project.totalCostUsd)}</span>
          </SettingsRow>
        ))}

        <SettingsRow
          // "No initialized projects" only after a successful read found none
          label={metrics && !error && projects.length === 0 ? t('accounts.metrics.empty') : t('accounts.metrics.total')}
          description={
            error ? (
              <span className="text-destructive">{error}</span>
            ) : metrics ? (
              t('accounts.metrics.updated', { time: formatRelativeTime(new Date(metrics.checkedAt)) })
            ) : (
              t('accounts.metrics.notUpdated')
            )
          }
        >
          <div className="flex items-center gap-3">
            {projects.length > 0 && (
              <span className="text-sm font-medium tabular-nums text-foreground">{formatCostUsd(total)}</span>
            )}
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={isLoading}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
              {t('accounts.metrics.refresh')}
            </Button>
          </div>
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
