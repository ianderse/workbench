import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmpDetection, OmpModelInfo } from '../../../shared/types/omp-detection';

const { detectOmp } = vi.hoisted(() => ({ detectOmp: vi.fn<() => Promise<OmpDetection>>() }));
vi.mock('../../agent-backend/omp-detection', () => ({ detectOmp }));

const pricedModel: OmpModelInfo = {
  provider: 'openai', id: 'test-model', selector: 'openai/test-model', pricingStatus: 'fixed',
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
};

beforeEach(() => {
  vi.resetModules();
  detectOmp.mockReset();
});

describe('OMP pricing catalog cache', () => {
  it('shares one read across simultaneous requests and ledger recomputations', async () => {
    let resolve!: (value: OmpDetection) => void;
    detectOmp.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { readOmpPricingModels } = await import('../omp-pricing');
    const first = readOmpPricingModels();
    const second = readOmpPricingModels();
    expect(detectOmp).toHaveBeenCalledTimes(1);
    resolve({ installed: true, models: [pricedModel] });
    expect(await first).toEqual([pricedModel]);
    expect(await second).toEqual([pricedModel]);
    expect(await readOmpPricingModels()).toEqual([pricedModel]);
    expect(detectOmp).toHaveBeenCalledTimes(1);
  });

  it('refreshes explicitly and retains previous known prices if refresh fails', async () => {
    detectOmp.mockResolvedValueOnce({ installed: true, models: [pricedModel] });
    const { readOmpPricingModels } = await import('../omp-pricing');
    await readOmpPricingModels();
    detectOmp.mockResolvedValueOnce({ installed: true, models: [], error: 'Catalog unavailable' });
    expect(await readOmpPricingModels(true)).toEqual([pricedModel]);
    const changed = { ...pricedModel, cost: { ...pricedModel.cost!, input: 3 } };
    detectOmp.mockResolvedValueOnce({ installed: true, models: [changed] });
    expect(await readOmpPricingModels(true)).toEqual([changed]);
    expect(detectOmp).toHaveBeenCalledTimes(3);
  });

  it('uses fallback rates without repeatedly probing an unavailable CLI', async () => {
    detectOmp.mockResolvedValue({ installed: false, models: [] });
    const { readOmpPricingModels } = await import('../omp-pricing');
    expect(await readOmpPricingModels()).toEqual([]);
    expect(await readOmpPricingModels()).toEqual([]);
    expect(detectOmp).toHaveBeenCalledTimes(1);
  });
});
