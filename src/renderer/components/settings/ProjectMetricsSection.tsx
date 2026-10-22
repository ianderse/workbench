/**
 * Metrics (Settings > Accounts): spending per project in each registered project with an
 * initialized `.workbench` directory - what its tasks' Claude Code runs cost plus every other
 * Claude Code session that ran in the project (agent windows, Insights, `claude` in a terminal) -
 * with a bar chart of what a project spent per day under its row (projects that have never spent
 * anything get none).
 * Shows the last result (refresh cache) straight away and reads the projects behind it, so the
 * figures are never stale while the page is open: the main process watches what they are read from
 * and reports every change, so what a session spends on its next answer shows up by itself.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { UsageCostChart, buildRangeDays, formatDay, type UsageCostRange } from './UsageCostChart';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { formatCostUsd } from '../../../shared/utils/claude-run';
import type { ProjectCostMetrics, ProjectDailyCost } from '../../../shared/types';

const CACHE_KEY = 'project-cost-metrics';

interface CachedMetrics {
  projects: ProjectCostMetrics[];
  checkedAt: string;
}

/** The translation key naming each range's total */
const RANGE_TOTAL: Record<UsageCostRange, string> = {
  all: 'accounts.metrics.chart.rangeTotal.all',
  '30d': 'accounts.metrics.chart.rangeTotal.days30',
  '7d': 'accounts.metrics.chart.rangeTotal.days7'
};

/**
 * One project: its name and how many tasks it has, with what the chart's range cost on the right -
 * the day under the pointer while the chart is hovered - and the chart underneath. A project that
 * has never spent anything gets no chart.
 */
function ProjectRow({ project }: { project: ProjectCostMetrics }) {
  const { t } = useTranslation('settings');
  const [range, setRange] = useState<UsageCostRange>('7d');
  const [hovered, setHovered] = useState<ProjectDailyCost | null>(null);

  // Metrics cached before the chart existed have no days
  const daily = project.daily ?? [];
  const days = useMemo(() => buildRangeDays(daily, range), [daily, range]);
  const rangeCost = days.reduce((sum, day) => sum + day.costUsd, 0);

  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span>{project.name}</span>
          <span className="text-(--nav-label-color)">
            · {t('accounts.metrics.tasks', { count: project.taskCount })}
          </span>
        </span>
      }
      footer={
        daily.length > 0 ? (
          <UsageCostChart
            days={days}
            range={range}
            onRangeChange={setRange}
            onHoverDay={setHovered}
            label={project.name}
          />
        ) : undefined
      }
    >
      <span className="text-sm tabular-nums text-foreground">
        {hovered
          ? `${formatDay(hovered.date)} · ${formatCostUsd(hovered.costUsd)}`
          : `${t(RANGE_TOTAL[range])} · ${formatCostUsd(rangeCost)}`}
      </span>
    </SettingsRow>
  );
}

export function ProjectMetricsSection() {
  const { t } = useTranslation('settings');
  const [metrics, setMetrics] = useState<CachedMetrics | undefined>(() => readRefreshCache<CachedMetrics>(CACHE_KEY));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A refresh the page asked for shows the spinner; one a window's spending triggered is quiet
  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const result = await window.electronAPI.getProjectCostMetrics();
      if (result.success && result.data) {
        const next = { projects: result.data, checkedAt: new Date().toISOString() };
        setMetrics(next);
        writeRefreshCache(CACHE_KEY, next);
      } else if (!quiet) {
        setError(result.error || t('accounts.metrics.error'));
      }
    } catch {
      if (!quiet) setError(t('accounts.metrics.error'));
    } finally {
      if (!quiet) setIsLoading(false);
    }
  }, [t]);

  // The stored figures show at once; what the project's sessions have spent since is read behind
  // them (quietly, unless there is nothing to show yet), and again whenever a session spends more
  useEffect(() => {
    void refresh(!!readRefreshCache<CachedMetrics>(CACHE_KEY));
    void window.electronAPI.watchProjectCostMetrics();
    const stopListening = window.electronAPI.onProjectCostMetricsChanged(() => void refresh(true));
    return () => {
      stopListening();
      void window.electronAPI.unwatchProjectCostMetrics();
    };
  }, [refresh]);

  const projects = metrics?.projects ?? [];

  return (
    <SettingsSection
      title={t('accounts.metrics.title')}
      action={
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={isLoading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
          {t('accounts.metrics.refresh')}
        </Button>
      }
    >
      <SettingsRows>
        {projects.map((project) => (
          <ProjectRow key={project.projectId} project={project} />
        ))}

        {/* "No initialized projects" only after a successful read found none */}
        {error ? (
          <SettingsRow label={<span className="text-destructive">{error}</span>} />
        ) : metrics && projects.length === 0 ? (
          <SettingsRow label={t('accounts.metrics.empty')} />
        ) : null}
      </SettingsRows>
    </SettingsSection>
  );
}
