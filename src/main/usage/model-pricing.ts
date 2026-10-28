/** Provider-specific base-rate comparisons for local token usage. */
import type { OmpModelInfo } from '../../shared/types/omp-detection';
import type { UsageCostComparison, UsageLocality, UsagePricingModel, UsageTotals } from '../../shared/types/usage';
import { claudePricingModels } from '../claude-code/session-pricing';

export function compareLocalUsage(
  local: UsageTotals,
  catalog: readonly OmpModelInfo[],
  classify: (provider: string | undefined) => UsageLocality,
): UsageCostComparison[] {
  const models = new Map<string, UsagePricingModel>();
  if (classify('anthropic') === 'cloud') {
    for (const { model, rates } of claudePricingModels()) {
      models.set(`anthropic/${model}`, { model, provider: 'anthropic', label: model, rates, source: 'builtin' });
    }
  }

  for (const model of catalog) {
    if (classify(model.provider) !== 'cloud' || !model.provider || !model.id || !model.cost) continue;
    // Unknown all-zero placeholders and subscription-included prices are not API list prices.
    if (model.pricingStatus !== 'fixed' && model.pricingStatus !== 'free') continue;
    const { input, output, cacheRead, cacheWrite } = model.cost;
    if (![input, output, cacheRead, cacheWrite].every((rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)) continue;
    models.set(`${model.provider}/${model.id}`, {
      model: model.id, provider: model.provider, label: model.name || model.id,
      rates: { input, output, cacheRead, cacheWrite }, source: 'omp',
    });
  }

  return [...models.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label) || a.model.localeCompare(b.model))
    .map((model) => {
      const breakdownUsd = {
        input: local.input * model.rates.input / 1_000_000,
        output: local.output * model.rates.output / 1_000_000,
        cacheRead: local.cacheRead * model.rates.cacheRead / 1_000_000,
        cacheWrite: local.cacheWrite * model.rates.cacheWrite / 1_000_000,
      };
      const cloudCostUsd = Object.values(breakdownUsd).reduce((sum, cost) => sum + cost, 0);
      return { ...model, breakdownUsd, cloudCostUsd, savingsUsd: cloudCostUsd - local.costUsd };
    });
}
