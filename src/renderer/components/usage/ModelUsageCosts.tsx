import { useTranslation } from 'react-i18next';
import type { UsageModelRow, UsageTotals } from '../../../shared/types/usage';
import { formatCostUsd } from '../../../shared/utils/claude-run';
import { formatTokens } from '../../../shared/utils/format-tokens';
import { hasCalculatedCost, isUsageModelRow } from './usage-summary-compat';

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** Known token value, with unavailable prices kept visible instead of counted as free. */
export function CalculatedCost({ totals }: { totals: Pick<UsageTotals, 'total' | 'calculatedCostUsd' | 'unpricedTokens'> }) {
  const { t } = useTranslation('usage');
  if (!hasCalculatedCost(totals)) return <>{t('byModel.unavailable')}</>;
  if (totals.unpricedTokens > 0 && totals.unpricedTokens >= totals.total) return <>{t('byModel.unpriced')}</>;
  const cost = formatCostUsd(totals.calculatedCostUsd);
  return <>{totals.unpricedTokens > 0 ? t('byModel.partialCost', { cost }) : cost}</>;
}

/** Each model's recorded token mix priced with its own rates, or its named local fallback. */
export function ModelUsageCosts({ models }: { models: UsageModelRow[] }) {
  const { t } = useTranslation('usage');
  if (!Array.isArray(models) || !models.every(isUsageModelRow)) return <p role="alert">{t('incompatible')}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('byModel.costBreakdown')}</caption>
        <thead>
          <tr className="text-left text-xs text-(--nav-label-color)">
            <th className="pb-2 pr-4 font-normal">{t('byModel.model')}</th>
            {KINDS.map((kind) => <th key={kind} className="pb-2 pl-4 text-right font-normal">{t(`kinds.${kind}`)}</th>)}
            <th className="pb-2 pl-4 text-right font-normal">{t('byModel.tokenCost')}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={`${model.provider ?? ''}/${model.model}`} className="border-t border-border align-top">
              <th scope="row" className="min-w-40 py-2 pr-4 text-left font-normal">
                <span className="break-all text-foreground">{model.model}</span>
                <span className="block text-xs text-muted-foreground">{[model.provider, t(`byModel.${model.locality}`)].filter(Boolean).join(', ')}</span>
                {model.pricing?.fallback && <span className="block text-xs text-muted-foreground">{t('byModel.fallback', { model: model.pricing.model })}</span>}
                {model.tokensPerSecond !== undefined && <span className="block text-xs text-muted-foreground">{t('byModel.tokensPerSecond', { rate: model.tokensPerSecond.toFixed(1) })}</span>}
              </th>
              {KINDS.map((kind) => (
                <td key={kind} className="whitespace-nowrap py-2 pl-4 text-right tabular-nums">
                  <span>{formatTokens(model[kind])}</span>
                  <span className="block text-xs text-muted-foreground">{model.pricing
                    ? t('byModel.rate', { cost: formatCostUsd(model.pricing.rates[kind]) })
                    : t('byModel.unpriced')}</span>
                </td>
              ))}
              <td className="whitespace-nowrap py-2 pl-4 text-right tabular-nums"><CalculatedCost totals={model} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-(--nav-label-color)">{t('byModel.calculation')}</p>
    </div>
  );
}
