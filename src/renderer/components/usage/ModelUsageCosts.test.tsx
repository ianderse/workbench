/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import { summarizeUsage } from '../../../main/usage/usage-summary';
import type { UsageEntry } from '../../../shared/types/usage';
import type { OmpModelInfo } from '../../../shared/types/omp-detection';
import { ModelUsageCosts } from './ModelUsageCosts';
import { UsageView } from './UsagePage';

afterEach(cleanup);

function entry(partial: Partial<UsageEntry>): UsageEntry {
  return {
    at: '2026-10-28T12:00:00Z', backend: 'omp', job: 'implement', model: 'cloud-a', provider: 'openai',
    input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, costUsd: 0, durationMs: 0,
    ...partial,
  };
}

const pricingModels: OmpModelInfo[] = [
  { provider: 'openai', id: 'cloud-a', selector: 'openai/cloud-a', pricingStatus: 'fixed', cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 } },
  { provider: 'openai', id: 'cloud-b', selector: 'openai/cloud-b', pricingStatus: 'fixed', cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 2.5 } },
  { provider: 'omlx', id: 'local-priced', selector: 'omlx/local-priced', pricingStatus: 'fixed', cost: { input: 1, output: 4, cacheRead: 0.05, cacheWrite: 1.25 } },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', selector: 'anthropic/claude-sonnet-5-5', pricingStatus: 'fixed', cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
];
const options = { now: new Date('2026-10-28T12:00:00Z'), classify: (provider: string | undefined) => provider === 'omlx' ? 'local' as const : 'cloud' as const, pricingModels };

describe('recorded usage costs', () => {
  it('shows costs calculated from each used model, with a named Sonnet fallback only for unpriced local usage', () => {
    const summary = summarizeUsage([
      entry({ costUsd: 4, taskId: 'cloud-task' }),
      entry({ model: 'cloud-b' }),
      entry({ provider: 'omlx', model: 'local-priced', costUsd: 0.3 }),
      entry({ provider: 'omlx', model: 'local-unpriced' }),
    ], options);
    render(<UsageView summary={summary} />);
    expect(screen.getByText('Calculated API value $59.70')).toBeInTheDocument();
    expect(screen.getByText('Reported cost $4.30')).toBeInTheDocument();
    expect(screen.getByText('Estimated local savings: $20.90')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Recorded token usage and calculated cost per model' });
    const modelRow = (model: string) => within(table).getByText(model, { exact: true }).closest('tr')!;
    expect(within(modelRow('cloud-a')).getByText('$12.10')).toBeInTheDocument();
    expect(within(modelRow('cloud-b')).getByText('$26.70')).toBeInTheDocument();
    expect(within(modelRow('local-priced')).getByText('$6.30')).toBeInTheDocument();
    expect(within(modelRow('local-priced')).queryByText(/Fallback rates/)).not.toBeInTheDocument();
    expect(within(modelRow('local-unpriced')).getByText('$14.60')).toBeInTheDocument();
    expect(within(modelRow('local-unpriced')).getByText('Fallback rates: claude-sonnet-5-5')).toBeInTheDocument();
    expect(within(modelRow('cloud-a')).getByText('$0.00 / 1M')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    const taskTable = screen.getByRole('columnheader', { name: 'Task' }).closest('table')!;
    expect(within(taskTable).getByText('$12.10')).toBeInTheDocument();
  });

  it('distinguishes known free usage from unavailable cloud pricing and labels partial totals', () => {
    const summary = summarizeUsage([
      entry({ model: 'unknown' }),
      entry({ model: 'free' }),
      entry({ model: 'cloud-a' }),
    ], {
      ...options,
      pricingModels: [...pricingModels, { provider: 'openai', id: 'free', selector: 'openai/free', pricingStatus: 'free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const view = render(<ModelUsageCosts models={summary.byModel} />);
    const unknownRow = screen.getByText('unknown', { exact: true }).closest('tr')!;
    expect(within(unknownRow).getAllByText('Unpriced')).toHaveLength(5);
    const freeRow = screen.getByText('free', { exact: true }).closest('tr')!;
    expect(within(freeRow).getByText('$0.00')).toBeInTheDocument();
    expect(within(freeRow).queryByText('Unpriced')).not.toBeInTheDocument();
    view.unmount();
    render(<UsageView summary={summary} />);
    expect(screen.getByText('Calculated API value $12.10 (partial)')).toBeInTheDocument();
    expect(screen.getByText('No model price for 4M tokens. Calculated totals include priced usage only')).toBeInTheDocument();
  });
});
