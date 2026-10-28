/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import '../../../shared/i18n';
import { summarizeUsage } from '../../../main/usage/usage-summary';
import type { UsageSummary, UsageTotals } from '../../../shared/types/usage';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import { CalculatedCost, ModelUsageCosts } from './ModelUsageCosts';
import { UsagePage, UsageView } from './UsagePage';
import { isUsageSummary } from './usage-summary-compat';

const restartMessage = 'Restart Workbench, then refresh Usage to load updated calculations';
const cacheKey = 'usage-summary:v3:test-project';
const methods = ['getUsageSummary', 'refreshUsageSummary', 'rebuildUsageFromHistory'] as const;
const originalMethods = methods.map((name) => Object.getOwnPropertyDescriptor(window.electronAPI, name));
const getUsage = vi.fn();
const refreshUsage = vi.fn();
const rebuildUsage = vi.fn();

const summary = summarizeUsage([{
  at: '2026-10-28T12:00:00Z', taskId: 'task-1', backend: 'claude', job: 'implement',
  provider: 'anthropic', model: 'claude-sonnet-5-5', input: 1_000_000, output: 0,
  cacheRead: 0, cacheWrite: 0, costUsd: 2, durationMs: 0,
}], { now: new Date('2026-10-28T12:00:00Z') });

function legacySummary(): unknown {
  const totals: Partial<UsageTotals> = { ...summary.totals };
  delete totals.calculatedCostUsd;
  delete totals.unpricedTokens;
  return { ...summary, totals, facts: { ...summary.facts, priciestTask: { taskId: 'task-1', costUsd: 2 } } };
}

const response = (value: unknown) => ({ success: true, data: { summary: value, backfilled: true } });

beforeEach(() => {
  getUsage.mockReset().mockResolvedValue(response(summary));
  refreshUsage.mockReset().mockResolvedValue(response(summary));
  rebuildUsage.mockReset().mockResolvedValue(response(summary));
  for (const [index, method] of methods.entries()) {
    Object.defineProperty(window.electronAPI, method, { configurable: true, writable: true, value: [getUsage, refreshUsage, rebuildUsage][index] });
  }
});

afterEach(() => {
  cleanup();
  for (const [index, method] of methods.entries()) {
    const descriptor = originalMethods[index];
    if (descriptor) Object.defineProperty(window.electronAPI, method, descriptor);
    else Reflect.deleteProperty(window.electronAPI, method);
  }
});

describe('Usage summary compatibility', () => {
  it('rejects a legacy summary held in memory before formatting the most expensive task', () => {
    render(<UsageView summary={legacySummary() as UsageSummary} />);
    expect(screen.getByRole('alert')).toHaveTextContent(restartMessage);
    expect(screen.queryByText(/\$0.00/)).not.toBeInTheDocument();
  });

  it('rejects an otherwise updated summary whose priciest fact still has the old cost field', () => {
    const oldFact = { ...summary, facts: { ...summary.facts, priciestTask: { taskId: 'task-1', costUsd: 2 } } };
    render(<UsageView summary={oldFact as unknown as UsageSummary} />);
    expect(screen.getByRole('alert')).toHaveTextContent(restartMessage);
  });

  it('shows unavailable for a standalone old calculated total instead of fabricating zero', () => {
    render(<CalculatedCost totals={{ total: 100 } as UsageTotals} />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/\$0.00/)).not.toBeInTheDocument();
  });

  it('rejects invalid pricing rates before a standalone model table formats them', () => {
    const row = { ...summary.byModel[0], pricing: { ...summary.byModel[0].pricing!, rates: { ...summary.byModel[0].pricing!.rates, input: NaN } } };
    render(<ModelUsageCosts models={[row]} />);
    expect(screen.getByRole('alert')).toHaveTextContent(restartMessage);
  });

  it.each([
    { ...summary, byModel: null },
    { ...summary, locality: { ...summary.locality, local: { ...summary.locality.local, calculatedCostUsd: undefined } } },
    { ...summary, byTask: [{ ...summary.byTask[0], unpricedTokens: undefined }] },
    { ...summary, facts: { ...summary.facts, fastest: { model: 'old', tokensPerSecond: undefined } } },
  ])('rejects missing containers or fields used by the dashboard', (malformed) => {
    expect(isUsageSummary(malformed)).toBe(false);
  });

  it('accepts and renders legitimate zero calculations', () => {
    const zero = summarizeUsage([{
      at: '2026-10-28T12:00:00Z', backend: 'omp', job: 'implement', provider: 'local', model: 'free',
      input: 100, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 0,
    }], {
      now: new Date('2026-10-28T12:00:00Z'),
      pricingModels: [{ provider: 'local', id: 'free', selector: 'local/free', pricingStatus: 'free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    expect(isUsageSummary(zero)).toBe(true);
    render(<UsageView summary={zero} />);
    expect(screen.getByText('Calculated API value $0.00')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Usage cache and IPC compatibility', () => {
  it('ignores a legacy cache, rejects old IPC without recaching or retrying, then accepts a new response on Refresh', async () => {
    const oldCache = { summary: legacySummary(), checkedAt: '2026-10-28T12:00:00Z' };
    writeRefreshCache(cacheKey, oldCache);
    getUsage.mockResolvedValue(response(legacySummary()));
    const view = render(<UsagePage projectId="test-project" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(restartMessage);
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(readRefreshCache(cacheKey)).toEqual(oldCache);
    expect(screen.queryByText('Calculated API value $2.00')).not.toBeInTheDocument();
    view.rerender(<UsagePage projectId="test-project" />);
    expect(getUsage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Calculated API value $2.00')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(refreshUsage).toHaveBeenCalledTimes(1);
    expect((readRefreshCache(cacheKey) as { summary: UsageSummary }).summary).toEqual(summary);
  });

  it('does not persist an old backend response when there was no cache', async () => {
    getUsage.mockResolvedValue(response(legacySummary()));
    render(<UsagePage projectId="test-project" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(restartMessage);
    expect(readRefreshCache(cacheKey)).toBeUndefined();
    expect(getUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps the valid cached-summary behavior without fetching on open', () => {
    writeRefreshCache(cacheKey, { summary, checkedAt: '2026-10-28T12:00:00Z' });
    render(<UsagePage projectId="test-project" />);
    expect(screen.getByText('Calculated API value $2.00')).toBeInTheDocument();
    expect(getUsage).not.toHaveBeenCalled();
    expect(refreshUsage).not.toHaveBeenCalled();
  });

  it('replaces a malformed cached container after one successful initial read', async () => {
    writeRefreshCache(cacheKey, { summary: { ...summary, byModel: null }, checkedAt: '2026-10-28T12:00:00Z' });
    render(<UsagePage projectId="test-project" />);
    await waitFor(() => expect(screen.getByText('Calculated API value $2.00')).toBeInTheDocument());
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect((readRefreshCache(cacheKey) as { summary: UsageSummary }).summary).toEqual(summary);
  });
});
