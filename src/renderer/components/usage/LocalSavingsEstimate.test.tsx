/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import type { UsageCostComparison, UsageSummary, UsageTotals } from '../../../shared/types/usage';
import { LocalSavingsEstimate } from './LocalSavingsEstimate';

afterEach(cleanup);

const local: UsageTotals = {
  input: 1e6, output: 2e6, cacheRead: 3e6, cacheWrite: 4e6, total: 10e6, costUsd: 2,
};
const first: UsageCostComparison = {
  provider: 'openai-codex', model: 'cloud-model', label: 'Cloud model', source: 'omp',
  rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  breakdownUsd: { input: 2, output: 20, cacheRead: 0.3, cacheWrite: 0 },
  cloudCostUsd: 22.3, savingsUsd: 20.3,
};
const second: UsageCostComparison = {
  ...first, provider: 'openai',
  rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  breakdownUsd: { input: 4, output: 40, cacheRead: 0.6, cacheWrite: 20 },
  cloudCostUsd: 64.6, savingsUsd: 62.6,
};

function summary(comparisons = [first, second]): UsageSummary {
  return {
    generatedAt: '2026-10-28T12:00:00Z', entryCount: 1, totals: local,
    byModel: [], byProvider: [], byJob: [], byTask: [], byDay: [],
    locality: { local, cloud: { ...local, total: 0 }, localShare: 1, comparisons },
    facts: { fallbackRuns: 0, failedRequests: 0 },
  };
}

describe('local savings comparison', () => {
  it('switches provider-specific rates, shows the token breakdown, and remembers the choice', () => {
    const view = render(<LocalSavingsEstimate summary={summary()} />);
    expect(screen.getByText('Estimated cloud savings: $20.30')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Estimated cloud cost using Cloud model' });
    const inputRow = within(table).getByRole('rowheader', { name: 'Input' }).closest('tr')!;
    expect(within(inputRow).getByText('1M')).toBeInTheDocument();
    expect(within(inputRow).getAllByText('$2.00')).toHaveLength(2);
    expect(screen.getByText('Cloud estimate $22.30 minus reported local cost $2.00')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Compare local usage with' }), {
      target: { value: JSON.stringify(['openai', 'cloud-model']) },
    });
    expect(screen.getByText('Estimated cloud savings: $62.60')).toBeInTheDocument();
    const cacheWriteRow = within(table).getByRole('rowheader', { name: 'Cache write' }).closest('tr')!;
    expect(within(cacheWriteRow).getByText('$5.00')).toBeInTheDocument();
    expect(within(cacheWriteRow).getByText('$20.00')).toBeInTheDocument();

    view.unmount();
    render(<LocalSavingsEstimate summary={summary()} />);
    expect(screen.getByText('Estimated cloud savings: $62.60')).toBeInTheDocument();
    expect(screen.getByText(/Rates from the OMP model catalog/)).toBeInTheDocument();
    expect(screen.getByText(/Excludes long-context premiums/)).toBeInTheDocument();
  });

  it('initially compares with a cloud model used in the project', () => {
    const data = summary();
    data.byModel = [{
      ...local, model: second.model, provider: second.provider, backend: 'omp', locality: 'cloud',
      requests: 1, durationMs: 0, timedOutput: 0,
    }];
    render(<LocalSavingsEstimate summary={data} />);
    expect(screen.getByText('Estimated cloud savings: $62.60')).toBeInTheDocument();
  });

  it('falls back safely if the remembered model is no longer available', () => {
    const view = render(<LocalSavingsEstimate summary={summary()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: JSON.stringify(['openai', 'cloud-model']) } });
    view.rerender(<LocalSavingsEstimate summary={summary([first])} />);
    expect(screen.getByText('Estimated cloud savings: $20.30')).toBeInTheDocument();
  });

  it('labels built-in rates and their cache-write assumption', () => {
    render(<LocalSavingsEstimate summary={summary([{ ...first, source: 'builtin' }])} />);
    expect(screen.getByText(/Rates from the built-in Claude price table/)).toBeInTheDocument();
    expect(screen.getByText('Cache writes use the five-minute rate')).toBeInTheDocument();
  });

  it('handles summaries with no available pricing', () => {
    render(<LocalSavingsEstimate summary={summary([])} />);
    expect(screen.getByText('No comparison pricing available. Refresh to load model rates')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
