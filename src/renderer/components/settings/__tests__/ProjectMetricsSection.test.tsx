/**
 * @vitest-environment jsdom
 *
 * What a project's row in Metrics reads out: the selected range, or the day under the pointer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { ProjectMetricsSection } from '../ProjectMetricsSection';
import type { ProjectCostMetrics } from '../../../../shared/types';

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

/** One project that spent on two of the last seven days, and much more before them */
const metrics: ProjectCostMetrics[] = [
  {
    projectId: 'p1',
    name: 'workbench',
    path: '/home/user/workbench',
    taskCount: 2,
    totalCostUsd: 99.5,
    daily: [
      { date: '2026-09-01', costUsd: 96.5 },
      { date: '2026-10-20', costUsd: 2 },
      { date: '2026-10-21', costUsd: 1 }
    ]
  }
];

/** The project's row, by the name in its label */
const projectRow = () => screen.getByText('workbench').closest('div.py-3') as HTMLElement;

describe('ProjectMetricsSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(TODAY);
    localStorage.clear();
    window.electronAPI = {
      getProjectCostMetrics: vi.fn(async () => ({ success: true, data: metrics })),
      watchProjectCostMetrics: vi.fn(async () => ({ success: true })),
      unwatchProjectCostMetrics: vi.fn(async () => ({ success: true })),
      onProjectCostMetricsChanged: vi.fn(() => () => {})
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads out what the selected range cost, and says which range that is', async () => {
    render(<ProjectMetricsSection />);

    await waitFor(() => expect(screen.getByText('workbench')).toBeInTheDocument());

    // The last 7 days are the range a chart opens on: $2 + $1, not the project's $99.50
    expect(projectRow()).toHaveTextContent('7d total · $3.00');
    expect(projectRow()).not.toHaveTextContent('$99.50');

    fireEvent.click(screen.getByRole('radio', { name: '30d' }));
    expect(projectRow()).toHaveTextContent('30d total · $3.00');

    // Everything the project ever spent, which reaches back past the last 30 days
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    expect(projectRow()).toHaveTextContent('All-time total · $99.50');
  });

  it('reads out the day under the pointer while the chart is hovered', async () => {
    render(<ProjectMetricsSection />);
    await waitFor(() => expect(screen.getByText('workbench')).toBeInTheDocument());

    fireEvent.mouseEnter(document.querySelector('[data-usage-day="2026-10-20"]') as HTMLElement);
    expect(projectRow()).toHaveTextContent('Oct 20 · $2.00');

    fireEvent.mouseLeave(document.querySelector('[data-usage-day="2026-10-20"]')?.parentElement as HTMLElement);
    expect(projectRow()).toHaveTextContent('7d total · $3.00');
  });

  it('still totals the projects under the list', async () => {
    render(<ProjectMetricsSection />);

    await waitFor(() => expect(screen.getByText('workbench')).toBeInTheDocument());
    const totalRow = screen.getByText('Total').closest('div.py-3') as HTMLElement;

    expect(totalRow).toHaveTextContent('$99.50');
  });
});
