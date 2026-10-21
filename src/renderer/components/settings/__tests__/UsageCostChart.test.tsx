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
import { UsageCostChart, buildRangeDays, formatDay, niceCeil, type UsageCostRange } from '../UsageCostChart';
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

// A Wednesday, so "this week" starts two days before it
const WEDNESDAY = new Date(2026, 9, 21, 15, 30);

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
    const days = buildRangeDays(daily, 'all', WEDNESDAY);

    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: '2026-10-15', costUsd: 1 });
    expect(days[1]).toEqual({ date: '2026-10-16', costUsd: 0 });
    expect(days[6]).toEqual({ date: '2026-10-21', costUsd: 0.25 });
  });

  it('covers the last 30 days, today included', () => {
    const days = buildRangeDays([{ date: '2026-01-05', costUsd: 1 }, ...daily], '30d', WEDNESDAY);

    expect(days).toHaveLength(30);
    expect(days[0].date).toBe('2026-09-22');
    expect(days[29].date).toBe('2026-10-21');
  });

  it('never reaches back past the first spending, so All is never the shortest range', () => {
    // The project's first day is inside the last 30 days: 30d can only show that day onwards
    const recent = buildRangeDays(daily, '30d', WEDNESDAY);

    expect(recent[0].date).toBe('2026-10-15');
    expect(recent).toHaveLength(buildRangeDays(daily, 'all', WEDNESDAY).length);
  });

  it('starts the week range on the closest Monday', () => {
    const days = buildRangeDays(daily, 'week', WEDNESDAY);

    expect(days.map((day) => day.date)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(days.map((day) => day.costUsd)).toEqual([0, 0.5, 0.25]);
  });

  it('keeps a Monday to itself', () => {
    const monday = buildRangeDays([{ date: '2026-10-15', costUsd: 1 }], 'week', new Date(2026, 9, 19, 9));

    expect(monday).toEqual([{ date: '2026-10-19', costUsd: 0 }]);
  });

  it('starts the week on the first spending when the project is newer than the week', () => {
    const days = buildRangeDays([{ date: '2026-10-20', costUsd: 1 }], 'week', WEDNESDAY);

    expect(days.map((day) => day.date)).toEqual(['2026-10-20', '2026-10-21']);
  });

  it('has no days for a project that never spent anything', () => {
    expect(buildRangeDays([], 'all', WEDNESDAY)).toEqual([]);
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

describe('UsageCostChart', () => {
  const daily = [
    { date: '2026-10-18', costUsd: 2 },
    { date: '2026-10-21', costUsd: 0.5 }
  ];

  /** What ProjectRow does: holds the range, reads out the day under the pointer */
  function Harness() {
    const [range, setRange] = useState<UsageCostRange>('week');
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
    vi.setSystemTime(WEDNESDAY);
    return render(<Harness />);
  };

  it('starts on this week and switches with the filter', () => {
    renderChart();

    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute('aria-checked', 'true');
    expect(bars()).toHaveLength(3);

    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    expect(bars()).toHaveLength(4);

    fireEvent.click(screen.getByRole('radio', { name: '30d' }));

    // The project's first day is inside the last 30 days, so 30d can't reach further back than All
    expect(bars()).toHaveLength(4);
  });

  it('caps the bar width so a couple of days are not chart-wide blocks', () => {
    renderChart();
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));

    const bar = bars()[0].firstElementChild as HTMLElement;
    expect(bar.className).toContain('max-w-6');
    expect(bar.className).toContain('w-[calc(100%-2px)]');
    // The tallest day fills the plot; a cheaper day is a fraction of it
    expect(bar.style.height).toBe('100%');
    expect((bars()[3].firstElementChild as HTMLElement).style.height).toBe('25%');
  });

  it('reports the day under the pointer', () => {
    renderChart();

    fireEvent.mouseEnter(bars()[0]);

    expect(screen.getByTestId('readout')).toHaveTextContent('Oct 19 · 0');
  });

  it('says a range the project spent nothing in is empty', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(WEDNESDAY);
    render(
      <UsageCostChart
        days={buildRangeDays([{ date: '2026-10-15', costUsd: 1 }], 'week')}
        range="week"
        onRangeChange={vi.fn()}
        onHoverDay={vi.fn()}
        label="Workbench"
      />
    );

    expect(screen.getByText('No usage in this range')).toBeInTheDocument();
    expect(bars()).toHaveLength(0);
  });
});
