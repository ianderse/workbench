/**
 * Usage cost chart (Settings > Accounts > Metrics)
 *
 * One bar per calendar day of a project's Claude Code spending, with a range filter under it. The
 * project's row owns the range and reads out the day under the pointer, so the chart is only the
 * plot and its filter.
 * The days always fit: every day gets an equal share of the plot and its bar is centred in that
 * share, capped at 24px (`max-w-6`) so a new project with two days of usage doesn't draw two
 * chart-wide blocks. The date under the axis is centred in the same share, so it reads under its
 * own bar; a label of a day at either end may reach past the plot, where there is only margin.
 * The axis holds as many dates as the plot is wide enough for, quiet days included, and thins them
 * out evenly when it is not. Nothing scrolls.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from './SettingsRow';
import { formatCostUsd } from '../../../shared/utils/claude-run';
import type { ProjectDailyCost } from '../../../shared/types';

/** Which days the chart shows */
export type UsageCostRange = 'all' | '30d' | '7d';

/** Days in the "30d" range, today included */
const RECENT_DAYS = 30;
/** Days in the "7d" range, today included */
const SHORT_DAYS = 7;
/** Shortest visible bar for a day that did cost something (px) */
const MIN_BAR_HEIGHT = 2;
/** Width a day label needs to read without touching the next one (px) */
const LABEL_WIDTH = 46;
/** How many labels fit before the plot has been measured (it is measured on the first paint) */
const UNMEASURED_LABELS = 7;

/** Local calendar day of a date (`YYYY-MM-DD`) */
function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Midnight of a `YYYY-MM-DD` day, in the user's own timezone */
function dayStart(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** First day a range covers, or null when the project has no usage to show */
function rangeStart(range: UsageCostRange, today: Date, firstSpending: string | undefined): Date | null {
  if (!firstSpending) return null;
  const first = dayStart(firstSpending);
  if (range === 'all') return first;
  const start = addDays(today, -((range === '7d' ? SHORT_DAYS : RECENT_DAYS) - 1));
  // No empty days before the project ever spent anything, which would make "All" the shortest range
  return start < first ? first : start;
}

/**
 * Every day of the selected range, oldest first, including the days nothing was spent: a bar
 * chart by date reads wrong when quiet days are left out.
 */
export function buildRangeDays(
  daily: ProjectDailyCost[],
  range: UsageCostRange,
  now: Date = new Date()
): ProjectDailyCost[] {
  const spending = new Map(daily.map((day) => [day.date, day.costUsd]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = rangeStart(range, today, daily[0]?.date);
  if (!start) return [];

  // A run dated after today (a clock that moved back) still gets its bar
  const last = daily[daily.length - 1]?.date;
  const end = last && dayStart(last) > today ? dayStart(last) : today;
  if (start > end) return [];

  const days: ProjectDailyCost[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const date = dayKey(day);
    days.push({ date, costUsd: spending.get(date) ?? 0 });
  }
  return days;
}

/** A round number at or above the highest bar, for the top of the scale */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => value <= candidate * magnitude * 1.000001) ?? 10;
  return step * magnitude;
}

/** Scale tick: cents while the amounts are small, whole dollars once they are not */
function formatAxisCost(usd: number): string {
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: usd < 10 ? 2 : 0
  });
}

/** Day label under the axis and in the hover readout ("Oct 21") */
export function formatDay(date: string): string {
  return dayStart(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Which days get a label: every one of them when they fit, and otherwise every second, third and
 * so on, counted back from the last day so the most recent one always reads. Days the project
 * spent nothing on are labelled like any other - the axis is a calendar, and a gap in it is as
 * much a part of the chart as a bar.
 */
export function labelledDays(count: number, plotWidth: number): Set<number> {
  if (count <= 1) return new Set([0]);
  const fit = plotWidth > 0 ? Math.max(1, Math.floor(plotWidth / LABEL_WIDTH)) : UNMEASURED_LABELS;
  const step = Math.max(1, Math.ceil(count / fit));

  const labels = new Set<number>();
  for (let index = count - 1; index >= 0; index -= step) labels.add(index);
  return labels;
}

interface UsageCostChartProps {
  /** Every day of the selected range, oldest first (see buildRangeDays) */
  days: ProjectDailyCost[];
  range: UsageCostRange;
  onRangeChange: (range: UsageCostRange) => void;
  /** The day under the pointer, which the project's row reads out */
  onHoverDay: (day: ProjectDailyCost | null) => void;
  /** What the chart is of, for its accessible name */
  label: string;
}

export function UsageCostChart({ days, range, onRangeChange, onHoverDay, label }: UsageCostChartProps) {
  const { t } = useTranslation('settings');
  const plot = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);

  // How many dates fit depends on how wide the plot is, which the window's size decides
  useLayoutEffect(() => {
    setPlotWidth(plot.current?.clientWidth ?? 0);
  }, [days.length]);
  useEffect(() => {
    const measure = () => setPlotWidth(plot.current?.clientWidth ?? 0);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const total = days.reduce((sum, day) => sum + day.costUsd, 0);
  const top = niceCeil(Math.max(0, ...days.map((day) => day.costUsd)));
  const labels = labelledDays(days.length, plotWidth);

  const ranges = [
    { value: 'all' as const, label: t('accounts.metrics.chart.ranges.all') },
    { value: '30d' as const, label: t('accounts.metrics.chart.ranges.days30') },
    { value: '7d' as const, label: t('accounts.metrics.chart.ranges.days7') }
  ];

  return (
    <figure className="m-0" aria-label={t('accounts.metrics.chart.label', { name: label })}>
      <div className="flex gap-2">
        {/* Dollar scale */}
        <div className="flex h-24 w-11 shrink-0 flex-col justify-between text-right text-[0.6875rem] leading-none text-(--nav-label-color) tabular-nums">
          {/* A range without spending has no scale to show */}
          {top > 0 && (
            <>
              <span>{formatAxisCost(top)}</span>
              <span>{formatAxisCost(top / 2)}</span>
              <span>{formatAxisCost(0)}</span>
            </>
          )}
        </div>

        {/* Plot: one equal share per day, bar centred in it */}
        <div ref={plot} className="relative min-w-0 flex-1">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-24">
            <div className="absolute inset-x-0 top-0 border-t border-settings-divider" />
            <div className="absolute inset-x-0 top-1/2 border-t border-settings-divider" />
          </div>

          {total === 0 ? (
            // Nothing to plot: a row of flat bars would only look like a broken chart
            <div className="flex h-24 items-center justify-center text-xs text-(--nav-label-color)">
              {t('accounts.metrics.chart.emptyRange')}
            </div>
          ) : (
            <div className="flex h-24 items-end border-b border-border" onMouseLeave={() => onHoverDay(null)}>
              {days.map((day) => (
                <div
                  key={day.date}
                  onMouseEnter={() => onHoverDay(day)}
                  title={`${formatDay(day.date)} · ${formatCostUsd(day.costUsd)}`}
                  data-usage-day={day.date}
                  className="flex h-full min-w-0 flex-1 items-end justify-center rounded-t-sm hover:bg-muted"
                >
                  {/* 2px of its share stays empty (neighbours never touch), 24px at the widest */}
                  <div
                    className="w-[calc(100%-2px)] min-w-px max-w-6 rounded-t-[4px] bg-foreground/80"
                    style={{
                      height: top > 0 ? `${(day.costUsd / top) * 100}%` : 0,
                      minHeight: day.costUsd > 0 ? MIN_BAR_HEIGHT : 0
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Day labels: never every day, so they can't collide */}
          <div className="relative mt-1.5 h-3 text-[0.6875rem] leading-none text-(--nav-label-color)">
            {(total === 0 ? [] : days).map((day, index) =>
              labels.has(index) ? (
                // On the middle of its day's share of the width, which is where its bar is. A
                // label of a narrow day is wider than that share and reaches over its neighbours,
                // which are days without a label, or past the plot, where there is only margin.
                <span
                  key={day.date}
                  className="absolute -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${((index + 0.5) / days.length) * 100}%` }}
                >
                  {formatDay(day.date)}
                </span>
              ) : null
            )}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <SegmentedControl
          value={range}
          options={ranges}
          onValueChange={(next) => {
            onRangeChange(next);
            onHoverDay(null);
          }}
          ariaLabel={t('accounts.metrics.chart.rangeLabel')}
          className="h-7"
        />
      </div>
    </figure>
  );
}
