/** Runtime checks for cached/IPC summaries while main and renderer versions can differ. */
import type { UsageModelRow, UsageSummary, UsageTotals } from '../../../shared/types/usage';

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const counts = (value: RecordValue, keys: string[]): boolean => keys.every((key) => count(value[key]));
const locality = (value: unknown): boolean => value === 'local' || value === 'cloud';

export function hasCalculatedCost(value: unknown): value is Pick<UsageTotals, 'total' | 'calculatedCostUsd' | 'unpricedTokens'> {
  return record(value) && counts(value, ['total', 'calculatedCostUsd', 'unpricedTokens']);
}

function totals(value: unknown): value is UsageTotals {
  return record(value) && hasCalculatedCost(value) && counts(value, ['input', 'output', 'cacheRead', 'cacheWrite', 'costUsd']);
}

export function isUsageModelRow(value: unknown): value is UsageModelRow {
  if (!record(value) || !totals(value) || !text(value.model) || !optional(value.provider, text)
    || (value.backend !== 'claude' && value.backend !== 'omp') || !locality(value.locality)
    || !counts(value, ['requests', 'durationMs', 'timedOutput']) || !optional(value.tokensPerSecond, count)) return false;
  const pricing = value.pricing;
  return pricing === undefined || (record(pricing) && text(pricing.model) && text(pricing.provider)
    && (pricing.source === 'omp' || pricing.source === 'builtin') && typeof pricing.fallback === 'boolean'
    && record(pricing.rates) && counts(pricing.rates, ['input', 'output', 'cacheRead', 'cacheWrite']));
}

/** Check every field formatted or traversed by the dashboard before rendering it. */
export function isUsageSummary(value: unknown): value is UsageSummary {
  if (!record(value) || !text(value.generatedAt) || !count(value.entryCount) || !totals(value.totals)) return false;
  const local = value.locality;
  if (!record(local) || !totals(local.local) || !totals(local.cloud) || !count(local.localShare)
    || local.localShare > 1 || !optional(local.savedCostUsd, finite)) return false;
  if (!Array.isArray(value.byModel) || !value.byModel.every(isUsageModelRow)) return false;
  if (!Array.isArray(value.byProvider) || !value.byProvider.every((row) => record(row) && totals(row) && text(row.provider) && locality(row.locality))) return false;
  if (!Array.isArray(value.byJob) || !value.byJob.every((row) => record(row) && totals(row) && text(row.job))) return false;
  if (!Array.isArray(value.byTask) || !value.byTask.every((row) => record(row) && totals(row) && text(row.taskId)
    && optional(row.title, text) && optional(row.reviewRounds, count))) return false;
  if (!Array.isArray(value.byDay) || !value.byDay.every((row) => record(row) && text(row.date)
    && counts(row, ['tokens', 'costUsd', 'calculatedCostUsd', 'unpricedTokens']))) return false;
  const facts = value.facts;
  if (!record(facts) || !counts(facts, ['fallbackRuns', 'failedRequests'])) return false;
  return optional(facts.chattiest, (fact) => record(fact) && text(fact.model) && count(fact.ratio))
    && optional(facts.fastest, (fact) => record(fact) && text(fact.model) && count(fact.tokensPerSecond))
    && optional(facts.priciestTask, (fact) => record(fact) && text(fact.taskId) && optional(fact.title, text) && count(fact.calculatedCostUsd));
}
