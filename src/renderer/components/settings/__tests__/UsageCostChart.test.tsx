/**
 * @vitest-environment jsdom
 *
 * The usage chart's range filter and its "everything fits" layout.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { useState } from 'react';
import {
  UsageCostChart,
  buildRangeDays,
  formatDay,
  labelledDays,
  niceCeil,
  type UsageCostRange
} from '../UsageCostChart';
import type { ProjectDailyCost } from '../../../../shared/types';

// jsdom has neither matchMedia nor ResizeObserver (both used by SegmentedControl)
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })) as unknown as typeof window.matchMedia;
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
}

const TODAY = new Date(2026, 9, 21, 15, 30);

const bars = () => document.querySelectorAll('[data-usage-day]');

afterEach(() => {
  vi.useRealTimers();
});

describe('buildRangeDays', () => {
  const daily = [
    { date: '2026-10-15', costUsd: 1 },
    { date: '2026-10-20', costUsd: 0.5 },
    { date: '2026-10-21', costUsd: 0.25 }
  ];

  it('fills the quiet days between the first spending and today', () => {
    const days = buildRangeDays(daily, 'all', TODAY);

    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: '2026-10-15', costUsd: 1 });
    expect(days[1]).toEqual({ date: '2026-10-16', costUsd: 0 });
    expect(days[6]).toEqual({ date: '2026-10-21', costUsd: 0.25 });
  });

  it('covers the last 30 days, today included', () => {
    const days = buildRangeDays([{ date: '2026-01-05', costUsd: 1 }, ...daily], '30d', TODAY);

    expect(days).toHaveLength(30);
    expect(days[0].date).toBe('2026-09-22');
    expect(days[29].date).toBe('2026-10-21');
  });

  it('never reaches back past the first spending, so All is never the shortest range', () => {
    // The project's first day is inside the last 30 days: 30d can only show that day onwards
    const recent = buildRangeDays(daily, '30d', TODAY);

    expect(recent[0].date).toBe('2026-10-15');
    expect(recent).toHaveLength(buildRangeDays(daily, 'all', TODAY).length);
  });

  it('covers the last 7 days, today included', () => {
    const days = buildRangeDays([{ date: '2026-01-05', costUsd: 1 }, ...daily], '7d', TODAY);

    expect(days).toHaveLength(7);
    expect(days.map((day) => day.date)).toEqual([
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21'
    ]);
    expect(days.map((day) => day.costUsd)).toEqual([1, 0, 0, 0, 0, 0.5, 0.25]);
  });

  it('starts the 7 day range on the first spending when the project is newer than it', () => {
    const days = buildRangeDays([{ date: '2026-10-20', costUsd: 1 }], '7d', TODAY);

    expect(days.map((day) => day.date)).toEqual(['2026-10-20', '2026-10-21']);
  });

  it('has no days for a project that never spent anything', () => {
    expect(buildRangeDays([], 'all', TODAY)).toEqual([]);
  });
});

describe('niceCeil', () => {
  it('rounds the top of the scale up to a round amount', () => {
    expect(niceCeil(0.37)).toBe(0.5);
    expect(niceCeil(1)).toBe(1);
    expect(niceCeil(1.2)).toBe(2);
    expect(niceCeil(23)).toBe(25);
    expect(niceCeil(0)).toBe(0);
  });
});

describe('labelledDays', () => {
  it('labels every day when the plot is wide enough for them', () => {
    expect(labelledDays(7, 690)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
  });

  it('thins the dates out evenly when they would not fit, keeping the last day', () => {
    // 690px fits 15 dates, so 41 days are labelled every third one, counted back from today
    const labels = labelledDays(41, 690);

    expect(labels.has(40)).toBe(true);
    expect(labels.has(37)).toBe(true);
    expect(labels.has(39)).toBe(false);
    expect(labels.size).toBe(14);
  });

  it('labels as many as a narrow plot holds, and always at least the last day', () => {
    expect(labelledDays(30, 100)).toEqual(new Set([29, 14]));
    expect(labelledDays(30, 20)).toEqual(new Set([29]));
    expect(labelledDays(1, 0)).toEqual(new Set([0]));
  });

  it('falls back to seven dates until the plot has been measured', () => {
    expect(labelledDays(7, 0).size).toBe(7);
    expect(labelledDays(30, 0).size).toBe(6);
  });
});

describe('UsageCostChart', () => {
  const daily = [
    { date: '2026-09-20', costUsd: 0.5 },
    { date: '2026-10-18', costUsd: 2 },
    { date: '2026-10-21', costUsd: 0.5 }
  ];

  /** The bar of one day, by its date */
  const barFor = (date: string) =>
    document.querySelector(`[data-usage-day="${date}"]`)?.firstElementChild as HTMLElement;

  /** What ProjectRow does: holds the range, reads out the day under the pointer */
  function Harness() {
    const [range, setRange] = useState<UsageCostRange>('7d');
    const [hovered, setHovered] = useState<ProjectDailyCost | null>(null);
    const days = buildRangeDays(daily, range);
    return (
      <>
        <p data-testid="readout">{hovered ? `${formatDay(hovered.date)} · ${hovered.costUsd}` : 'no day'}</p>
        <UsageCostChart
          days={days}
          range={range}
          onRangeChange={setRange}
          onHoverDay={setHovered}
          label="Workbench"
        />
      </>
    );
  }

  const renderChart = () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(TODAY);
    return render(<Harness />);
  };

  it('starts on the last 7 days and switches with the filter', () => {
    renderChart();

    expect(screen.getByRole('radio', { name: '7d' })).toHaveAttribute('aria-checked', 'true');
    expect(bars()).toHaveLength(7);

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    expect(bars()).toHaveLength(32);

    fireEvent.click(screen.getByRole('radio', { name: '30d' }));

    expect(bars()).toHaveLength(30);
  });

  it('caps the bar width so a couple of days are not chart-wide blocks', () => {
    renderChart();
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const bar = barFor('2026-10-18');
    expect(bar.className).toContain('max-w-6');
    expect(bar.className).toContain('w-[calc(100%-2px)]');
    // The tallest day fills the plot; a cheaper day is a fraction of it
    expect(bar.style.height).toBe('100%');
    expect(barFor('2026-09-20').style.height).toBe('25%');
  });

  it('puts each date under the bar it belongs to, quiet days included', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(TODAY);
    render(
      <UsageCostChart
        days={buildRangeDays([{ date: '2026-10-18', costUsd: 1 }, { date: '2026-10-21', costUsd: 2 }], 'all')}
        range="all"
        onRangeChange={vi.fn()}
        onHoverDay={vi.fn()}
        label="Workbench"
      />
    );

    // Oct 18 to Oct 21: each bar sits in the middle of its quarter of the plot, and so does its date
    const label = (text: string) => screen.getByText(text) as HTMLElement;
    expect(label('Oct 18').style.left).toBe('12.5%');
    // Nothing was spent on these two, and they are still on the axis
    expect(label('Oct 19').style.left).toBe('37.5%');
    expect(label('Oct 20').style.left).toBe('62.5%');
    expect(label('Oct 21').style.left).toBe('87.5%');
    // Centred on that point rather than aligned to it, however wide the date reads
    expect(label('Oct 18').className).toContain('-translate-x-1/2');
  });

  it('reports the day under the pointer', () => {
    renderChart();

    fireEvent.mouseEnter(bars()[0]);

    expect(screen.getByTestId('readout')).toHaveTextContent('Oct 15 · 0');
  });

  it('says a range the project spent nothing in is empty', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(TODAY);
    render(
      <UsageCostChart
        days={buildRangeDays([{ date: '2026-10-01', costUsd: 1 }], '7d')}
        range="7d"
        onRangeChange={vi.fn()}
        onHoverDay={vi.fn()}
        label="Workbench"
      />
    );

    expect(screen.getByText('No usage in this range')).toBeInTheDocument();
    expect(bars()).toHaveLength(0);
  });
});
