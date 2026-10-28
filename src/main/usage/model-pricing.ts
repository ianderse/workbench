/** Per-model base rates, with Sonnet fallback only for local models without their own price. */
import type { OmpModelInfo } from '../../shared/types/omp-detection';
import type { UsageModelPricing, UsagePricingRates } from '../../shared/types/usage';
import { claudePricingModels } from '../claude-code/session-pricing';

const SONNET_MODEL = 'claude-sonnet-5-5';

/** Build once per summary; provider-qualified identities keep distinct provider prices separate. */
export function modelPricingLookup(catalog: readonly OmpModelInfo[]): (
  provider: string, model: string, local: boolean,
) => UsageModelPricing | undefined {
  const models = new Map<string, UsageModelPricing>();
  const builtins = claudePricingModels();
  for (const model of catalog) {
    if (!model.provider || !model.id || !model.cost) continue;
    // Unknown all-zero placeholders and subscription-included costs are not API rate cards.
    if (model.pricingStatus !== 'fixed' && model.pricingStatus !== 'free') continue;
    const { input, output, cacheRead, cacheWrite } = model.cost;
    if (![input, output, cacheRead, cacheWrite].every((rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)) continue;
    models.set(`${model.provider}\u0000${model.id}`, {
      model: model.id, provider: model.provider,
      rates: { input, output, cacheRead, cacheWrite }, source: 'omp', fallback: false,
    });
  }

  const ownPrice = (provider: string, model: string): UsageModelPricing | undefined => {
    const exact = models.get(`${provider}\u0000${model}`);
    if (exact) return exact;
    if (provider !== 'anthropic') return undefined;
    const name = model.toLowerCase().replace(/^(?:[a-z]{2}\.)?anthropic\./, '');
    // Date suffixes identify releases of the same Claude model; unknown versions must stay unknown.
    const canonical = name.replace(/-\d{8}$/, '');
    const catalogPrice = models.get(`anthropic\u0000${canonical}`);
    if (catalogPrice) return catalogPrice;
    const stored = builtins.find(({ model: id }) => canonical === id);
    return stored ? { model, provider, rates: stored.rates, source: 'builtin', fallback: false } : undefined;
  };

  const sonnet = ownPrice('anthropic', SONNET_MODEL)!;
  return (provider, model, local) => ownPrice(provider, model) ?? (local ? { ...sonnet, fallback: true } : undefined);
}

export function tokenCostUsd(tokens: UsagePricingRates, rates: UsagePricingRates): number {
  return (tokens.input * rates.input + tokens.output * rates.output + tokens.cacheRead * rates.cacheRead + tokens.cacheWrite * rates.cacheWrite) / 1_000_000;
}
