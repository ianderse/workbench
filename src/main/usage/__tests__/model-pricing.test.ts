import { describe, expect, it } from 'vitest';
import { compareLocalUsage } from '../model-pricing';
import { classifyProvider } from '../provider-locality';
import { summarizeUsage } from '../usage-summary';
import type { OmpModelInfo } from '../../../shared/types/omp-detection';

const rates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const local = { input: 1_000_000, output: 200_000, cacheRead: 3_000_000, cacheWrite: 400_000, total: 4_600_000, costUsd: 0.5 };
const model = (partial: Partial<OmpModelInfo> = {}): OmpModelInfo => ({
  provider: 'openai', id: 'test-model', selector: 'openai/test-model', name: 'Test model',
  cost: rates, pricingStatus: 'fixed', ...partial,
});

describe('local model comparisons', () => {
  it('prices each token class separately and subtracts the reported local cost', () => {
    const comparison = compareLocalUsage(local, [model()], classifyProvider).find((row) => row.provider === 'openai')!;
    expect(comparison).toMatchObject({ model: 'test-model', label: 'Test model', source: 'omp', rates });
    expect(comparison.breakdownUsd).toEqual({ input: 2, output: 2, cacheRead: 0.3, cacheWrite: 1 });
    expect(comparison.cloudCostUsd).toBeCloseTo(5.3);
    expect(comparison.savingsUsd).toBeCloseTo(4.8);
  });

  it('uses catalog rates ahead of built-in rates and retains provider-specific prices', () => {
    const comparisons = compareLocalUsage(local, [
      model({ provider: 'anthropic', id: 'claude-sonnet-5-5', cost: rates }),
      model({ provider: 'openai-codex', cost: { ...rates, cacheWrite: 0 } }),
      model(),
    ], classifyProvider);
    const sonnet = comparisons.filter((row) => row.provider === 'anthropic' && row.model === 'claude-sonnet-5-5');
    expect(sonnet).toHaveLength(1);
    expect(sonnet[0]).toMatchObject({ source: 'omp', rates });
    const api = comparisons.find((row) => row.provider === 'openai')!;
    const codex = comparisons.find((row) => row.provider === 'openai-codex')!;
    expect(api.cloudCostUsd - codex.cloudCostUsd).toBeCloseTo(1);
  });

  it('omits local, unknown, subscription-included, variable and invalid prices', () => {
    const comparisons = compareLocalUsage(local, [
      model({ provider: 'omlx' }),
      model({ id: 'unknown', pricingStatus: 'unknown', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      model({ id: 'included', pricingStatus: 'included' }),
      model({ id: 'variable', pricingStatus: 'variable' }),
      model({ id: 'missing-status', pricingStatus: undefined }),
      model({ id: 'invalid', cost: { ...rates, input: NaN } }),
    ], classifyProvider);
    expect(comparisons.every((row) => row.source === 'builtin')).toBe(true);
  });

  it('keeps explicit zero rates and negative savings instead of claiming a saving', () => {
    const free = model({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pricingStatus: 'free' });
    const comparison = compareLocalUsage(local, [free], classifyProvider).find((row) => row.provider === 'openai')!;
    expect(comparison.cloudCostUsd).toBe(0);
    expect(comparison.savingsUsd).toBe(-0.5);
  });

  it('respects provider locality overrides for catalog and built-in comparisons', () => {
    expect(compareLocalUsage(local, [model()], () => 'local')).toEqual([]);
  });

  it('compares only local tokens and leaves the reported cloud spending unchanged', () => {
    const base = {
      at: '2026-10-28T12:00:00Z', job: 'implement' as const, backend: 'omp' as const,
      input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, durationMs: 0,
    };
    const summary = summarizeUsage([
      { ...base, model: 'qwen', provider: 'omlx', costUsd: 0.25 },
      { ...base, model: 'test-model', provider: 'openai', costUsd: 123 },
    ], { classify: classifyProvider, pricingModels: [model()] });
    const comparison = summary.locality.comparisons.find((row) => row.provider === 'openai')!;
    expect(comparison.cloudCostUsd).toBe(2);
    expect(comparison.savingsUsd).toBe(1.75);
    expect(summary.totals.costUsd).toBe(123.25);
    expect(summary.locality.cloud.costUsd).toBe(123);
  });
});
