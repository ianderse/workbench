import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageCostComparison, UsageSummary } from '../../../shared/types/usage';
import { formatCostUsd } from '../../../shared/utils/claude-run';
import { formatTokens } from '../../../shared/utils/format-tokens';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';

const COMPARISON_KEY = 'usage-comparison-model';
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const modelKey = (model: { provider: string; model: string }) => JSON.stringify([model.provider, model.model]);

/** Compare the recorded local token mix with a selectable cloud rate card. */
export function LocalSavingsEstimate({ summary }: { summary: UsageSummary }) {
  const { t } = useTranslation('usage');
  const [selected, setSelected] = useState(() => readRefreshCache<string>(COMPARISON_KEY));
  const { locality } = summary;
  const comparisons = locality.comparisons ?? [];
  const usedCloudModel = summary.byModel
    .filter((model) => model.locality === 'cloud')
    .map((model) => comparisons.find((comparison) => comparison.model === model.model
      && comparison.provider === (model.provider ?? (model.backend === 'claude' ? 'anthropic' : 'unknown'))))
    .find((model) => model !== undefined);
  const comparison: UsageCostComparison | undefined = comparisons.find((model) => modelKey(model) === selected)
    ?? usedCloudModel
    ?? comparisons.find((model) => model.provider === 'anthropic' && model.model === 'claude-sonnet-5-5')
    ?? comparisons[0];

  if (!comparison) return <p className="mt-3 text-sm text-muted-foreground">{t('locality.noPricing')}</p>;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <label className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {t('locality.compareWith')}
        <select
          className="min-w-0 max-w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          value={modelKey(comparison)}
          onChange={(event) => {
            setSelected(event.target.value);
            writeRefreshCache(COMPARISON_KEY, event.target.value);
          }}
        >
          {comparisons.map((model) => (
            <option key={modelKey(model)} value={modelKey(model)}>{model.label} · {model.provider}</option>
          ))}
        </select>
      </label>
      <p className="mt-3 text-sm font-medium text-foreground">
        {t('locality.estimatedSavings', { cost: formatCostUsd(comparison.savingsUsd) })}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('locality.breakdown', { model: comparison.label })}</caption>
          <thead>
            <tr className="text-left text-xs text-(--nav-label-color)">
              <th className="pb-1.5 font-normal">{t('locality.tokenKind')}</th>
              <th className="pb-1.5 text-right font-normal">{t('locality.tokens')}</th>
              <th className="pb-1.5 text-right font-normal">{t('locality.rate')}</th>
              <th className="pb-1.5 text-right font-normal">{t('locality.estimatedCost')}</th>
            </tr>
          </thead>
          <tbody>
            {KINDS.map((kind) => (
              <tr key={kind} className="border-t border-border">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{t(`kinds.${kind}`)}</th>
                <td className="py-1.5 text-right tabular-nums">{formatTokens(locality.local[kind])}</td>
                <td className="py-1.5 text-right tabular-nums">{formatCostUsd(comparison.rates[kind])}</td>
                <td className="py-1.5 text-right tabular-nums">{formatCostUsd(comparison.breakdownUsd[kind])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('locality.costComparison', {
          cloud: formatCostUsd(comparison.cloudCostUsd),
          local: formatCostUsd(locality.local.costUsd),
        })}
      </p>
      <p className="mt-1 text-xs text-(--nav-label-color)">{t(`locality.sources.${comparison.source}`)}. {t('locality.assumptions')}</p>
      {comparison.source === 'builtin' && <p className="mt-1 text-xs text-(--nav-label-color)">{t('locality.cacheWriteAssumption')}</p>}
    </div>
  );
}
