import { describe, expect, it } from 'vitest';
import { modelPricingLookup, tokenCostUsd } from '../model-pricing';
import { classifyProvider } from '../provider-locality';
import { summarizeUsage } from '../usage-summary';
import type { OmpModelInfo } from '../../../shared/types/omp-detection';
import type { UsageEntry, UsageTotals } from '../../../shared/types/usage';

const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const counts = { input: 1_000_000, output: 200_000, cacheRead: 3_000_000, cacheWrite: 400_000 };
const model = (partial: Partial<OmpModelInfo> = {}): OmpModelInfo => ({
  provider: 'openai', id: 'test-model', selector: 'openai/test-model', name: 'Test model',
  cost: rates, pricingStatus: 'fixed', ...partial,
});

function entry(partial: Partial<UsageEntry> = {}): UsageEntry {
  return {
    at: '2026-10-28T12:00:00Z', taskId: 't1', job: 'implement', backend: 'omp',
    provider: 'openai', model: 'test-model', ...counts, costUsd: 0, durationMs: 0, ...partial,
  };
}

const now = new Date('2026-10-28T18:00:00Z');

describe('per-model pricing', () => {
  it('prices input, output, cache reads and cache writes separately', () => {
    const pricing = modelPricingLookup([model()])('openai', 'test-model', false)!;
    expect(pricing).toMatchObject({ model: 'test-model', provider: 'openai', source: 'omp', fallback: false, rates });
    expect(tokenCostUsd(counts, pricing.rates)).toBeCloseTo(5.3);
  });

  it('keeps provider-specific rates and never substitutes another provider for cloud usage', () => {
    const lookup = modelPricingLookup([model(), model({ provider: 'openai-codex', cost: { ...rates, cacheWrite: 0 } })]);
    expect(tokenCostUsd(counts, lookup('openai', 'test-model', false)!.rates)).toBeCloseTo(5.3);
    expect(tokenCostUsd(counts, lookup('openai-codex', 'test-model', false)!.rates)).toBeCloseTo(4.3);
    expect(lookup('other-provider', 'test-model', false)).toBeUndefined();
    expect(lookup('openai', 'claude-sonnet-5-5', false)).toBeUndefined();
  });

  it('uses configured local rates before any Sonnet fallback, including explicit free prices', () => {
    const localRates = { input: 1, output: 4, cacheRead: 0.05, cacheWrite: 0.75 };
    const lookup = modelPricingLookup([
      model({ provider: 'omlx', id: 'qwen', cost: localRates }),
      model({ provider: 'omlx', id: 'free-qwen', pricingStatus: 'free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]);
    expect(lookup('omlx', 'qwen', true)).toMatchObject({ model: 'qwen', provider: 'omlx', rates: localRates, source: 'omp', fallback: false });
    expect(lookup('omlx', 'free-qwen', true)).toMatchObject({ model: 'free-qwen', provider: 'omlx', fallback: false });
    expect(tokenCostUsd(counts, lookup('omlx', 'free-qwen', true)!.rates)).toBe(0);
  });

  it('falls back only unpriced local models to Sonnet and prefers its catalog rates', () => {
    const lookup = modelPricingLookup([
      model({ provider: 'anthropic', id: 'claude-sonnet-5-5' }),
      model({ provider: 'omlx', id: 'qwen', pricingStatus: 'unknown', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ]);
    expect(lookup('omlx', 'qwen', true)).toEqual({ model: 'claude-sonnet-5-5', provider: 'anthropic', rates, source: 'omp', fallback: true });
    expect(lookup('openai', 'unknown', false)).toBeUndefined();
    expect(modelPricingLookup([])('omlx', 'qwen', true)).toMatchObject({ model: 'claude-sonnet-5-5', provider: 'anthropic', source: 'builtin', fallback: true });
  });

  it('keeps unknown, included, variable, missing and invalid cloud rates unpriced', () => {
    for (const candidate of [
      model({ pricingStatus: 'unknown', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      model({ pricingStatus: 'included' }), model({ pricingStatus: 'variable' }),
      model({ pricingStatus: undefined }), model({ cost: { ...rates, input: NaN } }),
    ]) expect(modelPricingLookup([candidate])('openai', 'test-model', false)).toBeUndefined();
  });

  it('uses stored Claude rates for exact and dated Anthropic models without matching unknown versions', () => {
    const lookup = modelPricingLookup([]);
    const exact = lookup('anthropic', 'claude-opus-5-5', false)!;
    expect(exact).toMatchObject({ source: 'builtin', fallback: false });
    expect(lookup('anthropic', 'claude-opus-5-5-20260401', false)?.rates).toEqual(exact.rates);
    expect(lookup('anthropic', 'us.anthropic.claude-opus-5-5', false)?.rates).toEqual(exact.rates);
    expect(lookup('anthropic', 'claude-opus-5-9', false)).toBeUndefined();
    expect(lookup('omlx', 'claude-opus-5-5', true)).toMatchObject({ model: 'claude-sonnet-5-5', fallback: true });
  });

  it('prefers canonical Anthropic catalog rates for dated and provider-prefixed Claude model ids', () => {
    const lookup = modelPricingLookup([model({ provider: 'anthropic', id: 'claude-sonnet-5-5' })]);
    for (const alias of ['claude-sonnet-5-5-20260401', 'us.anthropic.claude-sonnet-5-5', 'anthropic.claude-sonnet-5-5-20260401']) {
      expect(lookup('anthropic', alias, false)).toMatchObject({ model: 'claude-sonnet-5-5', rates, source: 'omp', fallback: false });
      expect(lookup('openai', alias, false)).toBeUndefined();
    }
  });
});

describe('calculated usage aggregation', () => {
  it('reconciles per-model, provider, job, task, locality and daily costs without changing reported costs', () => {
    const catalog = [
      model(),
      model({ provider: 'openai-codex', cost: { input: 3, output: 15, cacheRead: 0.2, cacheWrite: 0 } }),
      model({ provider: 'omlx', id: 'qwen', cost: { input: 1, output: 4, cacheRead: 0.05, cacheWrite: 0.75 } }),
      model({ provider: 'anthropic', id: 'claude-sonnet-5-5' }),
    ];
    const entries = [
      entry({ provider: 'omlx', model: 'qwen', costUsd: 0.5 }),
      entry({ provider: 'omlx', model: 'unpriced-local', input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }),
      entry({ taskId: 't2', job: 'plan', costUsd: 123 }),
      entry({ provider: 'openai-codex', taskId: 't2', job: 'plan' }),
      entry({ provider: 'unknown-cloud', model: 'unknown', input: 100, output: 11, cacheRead: 13, cacheWrite: 17, costUsd: 7 }),
    ];
    const summary = summarizeUsage(entries, { now, classify: classifyProvider, pricingModels: catalog });
    const localCalculated = 2.25 + 0.00745;
    const cloudCalculated = 5.3 + 6.6;
    expect(summary.totals.calculatedCostUsd).toBeCloseTo(localCalculated + cloudCalculated);
    expect(summary.locality.local.calculatedCostUsd).toBeCloseTo(localCalculated);
    expect(summary.locality.cloud.calculatedCostUsd).toBeCloseTo(cloudCalculated);
    expect(summary.locality.savedCostUsd).toBeCloseTo(localCalculated);
    expect(summary.totals.unpricedTokens).toBe(141);
    expect(summary.totals.costUsd).toBe(130.5);
    const sums = (rows: Array<Pick<UsageTotals, 'calculatedCostUsd' | 'unpricedTokens'>>) => ({
      cost: rows.reduce((sum, row) => sum + row.calculatedCostUsd, 0),
      unpriced: rows.reduce((sum, row) => sum + row.unpricedTokens, 0),
    });
    for (const rows of [summary.byModel, summary.byProvider, summary.byJob, summary.byTask, summary.byDay, [summary.locality.local, summary.locality.cloud]]) {
      expect(sums(rows).cost).toBeCloseTo(summary.totals.calculatedCostUsd);
      expect(sums(rows).unpriced).toBe(141);
    }
    expect(summary.byModel.find((row) => row.model === 'unknown')?.pricing).toBeUndefined();
    expect(summary.byModel.find((row) => row.model === 'unpriced-local')?.pricing?.fallback).toBe(true);
    expect(summary.facts.priciestTask?.taskId).toBe('t2');
    expect(summary.facts.priciestTask?.calculatedCostUsd).toBeCloseTo(11.9);
  });

  it('distinguishes a known free model from unknown cloud prices with positive reported spending', () => {
    const summary = summarizeUsage([
      entry({ provider: 'omlx', model: 'free-qwen', costUsd: 0.5 }),
      entry({ provider: 'unknown', model: 'unpriced', costUsd: 9 }),
    ], { now, classify: classifyProvider, pricingModels: [model({ provider: 'omlx', id: 'free-qwen', pricingStatus: 'fixed', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })] });
    const free = summary.byModel.find((row) => row.model === 'free-qwen')!;
    expect(free).toMatchObject({ calculatedCostUsd: 0, unpricedTokens: 0, pricing: { fallback: false } });
    expect(summary.byModel.find((row) => row.model === 'unpriced')).toMatchObject({ calculatedCostUsd: 0, unpricedTokens: 4_600_000, costUsd: 9 });
    expect(summary.locality.savedCostUsd).toBe(0);
  });

  it('does not claim local savings when there were no local tokens', () => {
    const summary = summarizeUsage([entry()], { now, classify: classifyProvider, pricingModels: [model()] });
    expect(summary.locality.savedCostUsd).toBeUndefined();
    expect(summary.totals.calculatedCostUsd).toBeCloseTo(5.3);
  });

  it('keeps configured local API value even when OMP reported the same computed token cost', () => {
    const summary = summarizeUsage([entry({ provider: 'omlx', model: 'qwen', costUsd: 5.3 })], {
      now, classify: classifyProvider, pricingModels: [model({ provider: 'omlx', id: 'qwen' })],
    });
    expect(summary.locality.savedCostUsd).toBeCloseTo(5.3);
    expect(summary.locality.local.calculatedCostUsd).toBeCloseTo(5.3);
    expect(summary.locality.local.costUsd).toBe(5.3);
  });

  it('recognizes Claude backend usage without an explicit provider as Anthropic', () => {
    const summary = summarizeUsage([entry({ provider: undefined, backend: 'claude', model: 'claude-sonnet-5-5' })], { now });
    expect(summary.byModel[0].pricing).toMatchObject({ provider: 'anthropic', fallback: false });
    expect(summary.totals.unpricedTokens).toBe(0);
  });
});
