/** Parsers for `omp --version` and `omp models` output */
import type { OmpModelCost, OmpModelInfo, OmpModelPricingStatus } from '../../shared/types/omp-detection';

export function parseOmpVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+[\w.-]*)/.exec(output)?.[1];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function modelCost(value: unknown): OmpModelCost | undefined {
  const cost = record(value);
  if (!cost) return undefined;
  const { input, output, cacheRead, cacheWrite } = cost;
  if (![input, output, cacheRead, cacheWrite].every((rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0)) return undefined;
  return { input, output, cacheRead, cacheWrite } as OmpModelCost;
}

const PRICING_STATUSES: readonly OmpModelPricingStatus[] = ['fixed', 'free', 'included', 'variable', 'unknown'];

/** `omp models --json` output, including optional catalog pricing metadata */
export function parseOmpModelsJson(output: string): OmpModelInfo[] | undefined {
  try {
    const data = record(JSON.parse(output));
    if (!data || !Array.isArray(data.models)) return undefined;
    const models: OmpModelInfo[] = [];
    for (const value of data.models) {
      const m = record(value);
      if (!m || typeof m.provider !== 'string' || typeof m.id !== 'string') continue;
      const cost = modelCost(m.cost);
      const pricingStatus = PRICING_STATUSES.find((status) => status === m.pricingStatus);
      models.push({
        provider: m.provider,
        id: m.id,
        selector: typeof m.selector === 'string' && m.selector ? m.selector : `${m.provider}/${m.id}`,
        ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
        ...(cost ? { cost } : {}),
        ...(pricingStatus ? { pricingStatus } : {}),
      });
    }
    return models;
  } catch {
    return undefined;
  }
}

/** Table output: "provider (n)" heading lines followed by box-drawn rows whose first cell is the model id */
export function parseOmpModelsTable(output: string): OmpModelInfo[] {
  const models: OmpModelInfo[] = [];
  let provider = '';
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^([^\s│┌├└─]+)\s+\(\d+\)$/.exec(line);
    if (heading) {
      provider = heading[1];
      continue;
    }
    if (!provider || !line.startsWith('│')) continue;
    const cell = line.split('│')[1]?.trim();
    if (!cell || cell === 'model') continue;
    models.push({ provider, id: cell, selector: `${provider}/${cell}` });
  }
  return models;
}

export function parseOmpModels(output: string): OmpModelInfo[] {
  return parseOmpModelsJson(output) ?? parseOmpModelsTable(output);
}
