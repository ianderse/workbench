/**
 * Usage page: the token usage of the selected project
 *
 * Shows the last summary straight away (refresh cache) and only reads the ledger again on the
 * Refresh button, or once when nothing was read before. "Rebuild from history" imports what the
 * project's tasks spent before the ledger existed (safe to repeat).
 *
 * Charts follow the Metrics chart (`settings/UsageCostChart.tsx`): plain CSS bars on the design
 * tokens, with the values written out next to them so no meaning rides on color alone.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { useProjectStore } from '../../stores/project-store';
import { formatCostUsd } from '../../../shared/utils/claude-run';
import { formatTokens } from '../../../shared/utils/format-tokens';
import { formatDay, niceCeil } from '../settings/UsageCostChart';
import { CalculatedCost, ModelUsageCosts } from './ModelUsageCosts';
import type { UsageSummary, UsageTotals } from '../../../shared/types/usage';

const CACHE_PREFIX = 'usage-summary:v3:';
const TOP_TASKS = 8;

/** Segment colors: design tokens, so light and dark follow the theme */
const KIND_CLASS = {
  input: 'bg-primary',
  output: 'bg-success',
  cacheRead: 'bg-foreground/35',
  cacheWrite: 'bg-warning',
} as const;
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function Card({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-xl border border-border bg-card/60 p-4', className)}>
      {title && <h2 className="mb-3 text-sm font-medium text-foreground">{title}</h2>}
      {children}
    </section>
  );
}

/** A row of proportional bars: label, bar, value */
function BarList({ rows }: { rows: Array<{ key: string; label: string; sub?: string; value: number; text: string; barClass?: string }> }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <li key={row.key} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-foreground">
              {row.label}
              {row.sub && <span className="ml-1.5 text-xs text-(--nav-label-color)">{row.sub}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{row.text}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', row.barClass ?? 'bg-foreground/70')}
              style={{ width: `${Math.max(row.value > 0 ? 2 : 0, (row.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** input / output / cache read / cache write as one bar, with a legend that spells the numbers out */
function SegmentedBar({ totals }: { totals: UsageTotals }) {
  const { t } = useTranslation('usage');
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={KINDS.map((k) => `${t(`kinds.${k}`)} ${formatTokens(totals[k])}`).join(', ')}>
        {KINDS.map((kind) => (
          <div
            key={kind}
            className={KIND_CLASS[kind]}
            style={{ width: totals.total > 0 ? `${(totals[kind] / totals.total) * 100}%` : 0 }}
          />
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
        {KINDS.map((kind) => (
          <div key={kind} className="flex items-center gap-2">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', KIND_CLASS[kind])} />
            <dt className="text-muted-foreground">{t(`kinds.${kind}`)}</dt>
            <dd className="ml-auto tabular-nums text-foreground">{formatTokens(totals[kind])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DayBars({ summary }: { summary: UsageSummary }) {
  const { t } = useTranslation('usage');
  const days = summary.byDay;
  const top = niceCeil(Math.max(0, ...days.map((day) => day.tokens)));
  if (top === 0) {
    return <p className="py-6 text-center text-xs text-(--nav-label-color)">{t('days.empty')}</p>;
  }
  return (
    <figure className="m-0" aria-label={t('days.label')}>
      <div className="flex gap-2">
        <div className="flex h-24 w-11 shrink-0 flex-col justify-between text-right text-[0.6875rem] leading-none text-(--nav-label-color) tabular-nums">
          <span>{formatTokens(top)}</span>
          <span>{formatTokens(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-24">
            <div className="absolute inset-x-0 top-0 border-t border-settings-divider" />
            <div className="absolute inset-x-0 top-1/2 border-t border-settings-divider" />
          </div>
          <div className="flex h-24 items-end border-b border-border">
            {days.map((day) => (
              <div
                key={day.date}
                title={t('days.bar', { day: formatDay(day.date), tokens: formatTokens(day.tokens) })}
                className="flex h-full min-w-0 flex-1 items-end justify-center rounded-t-sm hover:bg-muted"
              >
                <div
                  className="w-[calc(100%-2px)] min-w-px max-w-6 rounded-t-[4px] bg-foreground/80"
                  style={{ height: `${(day.tokens / top) * 100}%`, minHeight: day.tokens > 0 ? 2 : 0 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[0.6875rem] leading-none text-(--nav-label-color)">
            <span>{formatDay(days[0].date)}</span>
            <span>{formatDay(days[days.length - 1].date)}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

interface UsageViewProps {
  summary: UsageSummary;
  onOpenTask?: (taskId: string) => void;
}

/** The dashboard for a summary with at least one entry */
export function UsageView({ summary, onOpenTask }: UsageViewProps) {
  const { t } = useTranslation('usage');
  const { totals, locality, facts } = summary;
  const localPercent = Math.round(locality.localShare * 100);
  const topTasks = summary.byTask.slice(0, TOP_TASKS);
  const taskLabel = (id: string, title?: string) => title || t('tasks.untitled', { id });
  const biggest = facts.priciestTask ?? (summary.byTask[0]
    ? { taskId: summary.byTask[0].taskId, title: summary.byTask[0].title, calculatedCostUsd: 0 }
    : undefined);
  const biggestTotal = biggest ? summary.byTask.find((row) => row.taskId === biggest.taskId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Hero */}
      <Card>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-4xl font-semibold tracking-tight tabular-nums text-foreground">{formatTokens(totals.total)}</span>
          <span className="text-sm text-muted-foreground">{t('hero.tokens')}</span>
          <div className="ml-auto text-right text-sm text-muted-foreground">
            <p>{t('hero.calculatedCost')} <CalculatedCost totals={totals} /></p>
            <p className="text-xs">{totals.costUsd > 0 ? t('hero.cost', { cost: formatCostUsd(totals.costUsd) }) : t('hero.noCost')}</p>
          </div>
        </div>
        <div className="mt-4">
          <SegmentedBar totals={totals} />
        </div>
        {totals.unpricedTokens > 0 && <p className="mt-3 text-xs text-muted-foreground">{t('hero.unpriced', { tokens: formatTokens(totals.unpricedTokens) })}</p>}
      </Card>

      {/* 2. Local and cloud */}
      <Card title={t('locality.title')}>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <div className="text-2xl font-semibold tabular-nums text-foreground">{formatTokens(locality.local.total)}</div>
            <div className="text-sm text-muted-foreground">{t('locality.local')}</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-foreground">{formatTokens(locality.cloud.total)}</div>
            <div className="text-sm text-muted-foreground">{t('locality.cloud')}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t('locality.cloudCost')} <CalculatedCost totals={locality.cloud} /></div>
          </div>
        </div>
        <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={t('locality.share', { percent: localPercent })}>
          <div className="bg-success" style={{ width: `${locality.localShare * 100}%` }} />
        </div>
        <p className="mt-3 text-xs text-(--nav-label-color)">{t('locality.share', { percent: localPercent })}</p>
        {locality.local.total > 0
          ? <div className="mt-3">
              <p className="text-sm font-medium text-foreground">{locality.savedCostUsd !== undefined
                ? t('locality.estimatedSavings', { cost: formatCostUsd(locality.savedCostUsd) })
                : t('byModel.unpriced')}</p>
              <p className="mt-1 text-xs text-(--nav-label-color)">{t('locality.calculation')}</p>
            </div>
          : <p className="mt-2 text-sm text-foreground">{t('locality.none')}</p>}
      </Card>

      {/* 3. Recorded usage and cost per model */}
      <Card title={t('byModel.title')}><ModelUsageCosts models={summary.byModel} /></Card>
      <Card title={t('byJob.title')}>
          <BarList
            rows={summary.byJob.map((job) => ({
              key: job.job,
              label: t(`jobs.${job.job}`),
              value: job.total,
              text: formatTokens(job.total),
            }))}
          />
      </Card>

      {/* 4. Top tasks */}
      {topTasks.length > 0 && (
        <Card title={t('tasks.title')}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-(--nav-label-color)">
                  <th className="pb-1.5 font-normal">{t('tasks.task')}</th>
                  <th className="pb-1.5 text-right font-normal">{t('tasks.tokens')}</th>
                  <th className="pb-1.5 text-right font-normal">{t('tasks.cost')}</th>
                  <th className="pb-1.5 text-right font-normal">{t('tasks.rounds')}</th>
                </tr>
              </thead>
              <tbody>
                {topTasks.map((task) => (
                  <tr key={task.taskId} className="border-t border-border">
                    <td className="max-w-0 py-1.5 pr-3">
                      <button
                        type="button"
                        onClick={() => onOpenTask?.(task.taskId)}
                        aria-label={t('tasks.open', { title: taskLabel(task.taskId, task.title) })}
                        className="block w-full truncate text-left text-foreground hover:underline"
                      >
                        {taskLabel(task.taskId, task.title)}
                      </button>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokens(task.total)}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground"><CalculatedCost totals={task} /></td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{task.reviewRounds ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* 5. Last 30 days */}
      <Card title={t('days.title')}>
        <DayBars summary={summary} />
      </Card>

      {/* 6. Fun facts */}
      <Card title={t('facts.title')}>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label={t('facts.chattiest')} value={facts.chattiest ? t('facts.chattiestValue', { model: facts.chattiest.model, ratio: facts.chattiest.ratio.toFixed(facts.chattiest.ratio < 0.1 ? 3 : 2) }) : undefined} />
          <Fact label={t('facts.fastest')} value={facts.fastest ? t('facts.fastestValue', { model: facts.fastest.model, rate: facts.fastest.tokensPerSecond.toFixed(1) }) : undefined} />
          <Fact
            label={facts.priciestTask ? t('facts.priciest') : t('facts.biggest')}
            value={biggest && biggestTotal
              ? t('facts.taskValue', {
                title: taskLabel(biggest.taskId, biggest.title),
                value: facts.priciestTask ? formatCostUsd(biggest.calculatedCostUsd) : `${formatTokens(biggestTotal.total)} ${t('hero.tokens')}`,
              })
              : undefined}
          />
          <Fact label={t('facts.retries')} value={t('facts.retriesValue', { fallbacks: facts.fallbackRuns, failures: facts.failedRequests })} />
        </dl>
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value?: string }) {
  const { t } = useTranslation('usage');
  return (
    <div className="min-w-0">
      <dt className="text-xs text-(--nav-label-color)">{label}</dt>
      <dd className="truncate text-foreground">{value ?? t('facts.none')}</dd>
    </div>
  );
}

interface UsagePageProps {
  projectId: string;
  onOpenTask?: (taskId: string) => void;
}

interface CachedUsage {
  summary: UsageSummary;
  checkedAt: string;
}

export function UsagePage({ projectId, onOpenTask }: UsagePageProps) {
  const { t } = useTranslation('usage');
  const projectName = useProjectStore((state) => state.projects.find((p) => p.id === projectId)?.name ?? '');
  const [cached, setCached] = useState<CachedUsage | undefined>(() => readRefreshCache<CachedUsage>(CACHE_PREFIX + projectId));
  const [busy, setBusy] = useState<'load' | 'refresh' | 'rebuild' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (kind: 'load' | 'refresh' | 'rebuild') => {
    setBusy(kind);
    setError(null);
    try {
      const api = window.electronAPI;
      const result = kind === 'rebuild'
        ? await api.rebuildUsageFromHistory(projectId)
        : kind === 'refresh'
          ? await api.refreshUsageSummary(projectId)
          : await api.getUsageSummary(projectId);
      if (result.success && result.data) {
        const next = { summary: result.data.summary, checkedAt: new Date().toISOString() };
        writeRefreshCache(CACHE_PREFIX + projectId, next);
        setCached(next);
      } else {
        setError(result.error ?? 'Unknown error');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [projectId]);

  // Switching project shows that project's last summary; nothing is read when there is one
  useEffect(() => {
    const stored = readRefreshCache<CachedUsage>(CACHE_PREFIX + projectId);
    setCached(stored);
    setError(null);
    if (!stored) void load('load');
  }, [projectId, load]);

  const summary = cached?.summary;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Gauge className="size-5 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight text-foreground">{t('title')}</h1>
            <p className="truncate text-xs text-(--nav-label-color)">
              {projectName && t('subtitle', { project: projectName })}
              {cached && ` · ${t('updated', { time: new Date(cached.checkedAt).toLocaleTimeString() })}`}
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void load('refresh')}>
              <RefreshCw className={cn('size-3.5', busy === 'refresh' && 'animate-spin')} aria-hidden="true" />
              {busy === 'refresh' ? t('actions.refreshing') : t('actions.refresh')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void load('rebuild')}>
              {busy === 'rebuild' ? t('actions.rebuilding') : t('actions.rebuild')}
            </Button>
          </div>
        </header>

        {error && <p role="alert" className="text-sm text-destructive">{t('error', { error })}</p>}

        {!summary ? (
          busy ? <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p> : null
        ) : summary.entryCount === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-14 text-center">
            <Gauge className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">{t('empty.title')}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t('empty.description')}</p>
          </div>
        ) : (
          <UsageView summary={summary} onOpenTask={onOpenTask} />
        )}
      </div>
    </div>
  );
}
