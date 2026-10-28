/**
 * Token usage ledger and its summary (Usage page)
 *
 * Every model run is one line of a project's `.workbench/usage.jsonl` (`UsageEntry`);
 * `summarizeUsage()` (main/usage/usage-summary.ts) turns the lines into a `UsageSummary`.
 */

export const USAGE_JOBS = [
  'triage', 'plan', 'implement', 'validate', 'revise', 'resync', 'review', 'spec_review', 'breakdown', 'grooming', 'title',
  'commit', 'pr', 'merge', 'insights', 'advisor', 'summary', 'other',
] as const;
export type UsageJob = (typeof USAGE_JOBS)[number];

export type UsageBackend = 'claude' | 'omp';
export type UsageLocality = 'local' | 'cloud';

/** One model's share of one run (or, for a backfilled entry, one model reply) */
export interface UsageEntry {
  /** When the run ended (ISO) */
  at: string;
  projectId?: string;
  taskId?: string;
  job: UsageJob;
  backend: UsageBackend;
  provider?: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** Time the model spent answering; 0 when unknown */
  durationMs: number;
  runId?: string;
  /** Model requests behind this entry (default 1) */
  requests?: number;
  /** Requests that failed */
  failures?: number;
  /** The model was an OMP fallback, not the one the run started on */
  fallback?: boolean;
  /** `backfill` for entries imported from earlier session files */
  source?: 'backfill';
  /** Session the tokens were spent in */
  sessionId?: string;
  /** Backfill: identifies the imported reply, so a second import skips it */
  key?: string;
  /** Live OMP runs: timestamps (ms) of the first and last reply, so a backfill skips them */
  msFrom?: number;
  msTo?: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite */
  total: number;
  /** Cost reported by the backend, unchanged from the ledger. */
  costUsd: number;
  /** Token cost at known model rates, excluding usage without a known price. */
  calculatedCostUsd: number;
  /** Tokens whose provider/model has no usable rates. Known free usage is priced. */
  unpricedTokens: number;
}

export interface UsageModelRow extends UsageTotals {
  model: string;
  provider?: string;
  backend: UsageBackend;
  locality: UsageLocality;
  requests: number;
  /** Time of the entries that know their duration */
  durationMs: number;
  /** Output tokens of those entries */
  timedOutput: number;
  /** Output tokens per second, when durations are known */
  tokensPerSecond?: number;
  pricing?: UsageModelPricing;
}

export interface UsageProviderRow extends UsageTotals {
  provider: string;
  locality: UsageLocality;
}

export interface UsageJobRow extends UsageTotals {
  job: UsageJob;
}

export interface UsageTaskRow extends UsageTotals {
  taskId: string;
  title?: string;
  /** AI review rounds the task went through */
  reviewRounds?: number;
}

export interface UsageDayRow {
  /** Local calendar day `YYYY-MM-DD` */
  date: string;
  tokens: number;
  costUsd: number;
  calculatedCostUsd: number;
  unpricedTokens: number;
}

/** Base rates in USD per million tokens. Cache writes use the model catalog's base rate. */
export interface UsagePricingRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Rates used for this model; local models without a price use Sonnet as a fallback. */
export interface UsageModelPricing {
  model: string;
  provider: string;
  rates: UsagePricingRates;
  source: 'omp' | 'builtin';
  fallback: boolean;
}

export interface UsageSummary {
  generatedAt: string;
  entryCount: number;
  totals: UsageTotals;
  byModel: UsageModelRow[];
  byProvider: UsageProviderRow[];
  locality: {
    local: UsageTotals;
    cloud: UsageTotals;
    /** Share of all tokens that ran locally, 0..1 */
    localShare: number;
    /** Avoided API token value of local usage; reported token costs are not payments. Excludes hardware and power. */
    savedCostUsd?: number;
  };
  byJob: UsageJobRow[];
  byTask: UsageTaskRow[];
  /** The last 30 days, oldest first, quiet days included */
  byDay: UsageDayRow[];
  facts: {
    /** Highest output per input token */
    chattiest?: { model: string; ratio: number };
    fastest?: { model: string; tokensPerSecond: number };
    priciestTask?: { taskId: string; title?: string; calculatedCostUsd: number };
    /** Runs on an OMP fallback model */
    fallbackRuns: number;
    failedRequests: number;
  };
}

/** What the Usage page gets from the main process */
export interface UsageSummaryResult {
  summary: UsageSummary;
  /** The one-time import of earlier sessions has run for this project */
  backfilled: boolean;
}
