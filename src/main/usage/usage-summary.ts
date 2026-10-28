/**
 * Usage summary
 *
 * `summarizeUsage()` turns a project's ledger entries into everything the Usage page shows. Pure:
 * the caller supplies the provider classifier, task titles and the clock.
 */
import type { OmpModelInfo } from '../../shared/types/omp-detection';
import { modelPricingLookup, tokenCostUsd } from './model-pricing';
import type {
  UsageDayRow, UsageEntry, UsageJob, UsageJobRow, UsageLocality, UsageModelRow, UsageProviderRow,
  UsageSummary, UsageTaskRow, UsageTotals,
} from '../../shared/types/usage';

/** Days the "last days" chart covers, today included */
export const USAGE_DAYS = 30;

export interface SummarizeOptions {
  now?: Date;
  /** Where a provider's tokens ran; default: everything is cloud */
  classify?: (provider: string | undefined) => UsageLocality;
  /** Title and AI review rounds per task id */
  tasks?: ReadonlyMap<string, { title?: string; reviewRounds?: number }>;
  /** Provider-qualified base prices from the OMP model catalog; stored Claude rates are fallback. */
  pricingModels?: readonly OmpModelInfo[];
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0, calculatedCostUsd: 0, unpricedTokens: 0 };
}

function add(target: UsageTotals, entry: UsageEntry, calculatedCostUsd: number, unpricedTokens: number): void {
  target.input += entry.input;
  target.output += entry.output;
  target.cacheRead += entry.cacheRead;
  target.cacheWrite += entry.cacheWrite;
  target.total += entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
  target.costUsd += entry.costUsd;
  target.calculatedCostUsd += calculatedCostUsd;
  target.unpricedTokens += unpricedTokens;
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const byTotalDesc = <T extends UsageTotals>(a: T, b: T): number => b.total - a.total || b.costUsd - a.costUsd;

export function summarizeUsage(entries: readonly UsageEntry[], options: SummarizeOptions = {}): UsageSummary {
  const now = options.now ?? new Date();
  const classify = options.classify ?? (() => 'cloud' as const);
  const pricingFor = modelPricingLookup(options.pricingModels ?? []);

  const totals = emptyTotals();
  const local = emptyTotals();
  const cloud = emptyTotals();
  const models = new Map<string, UsageModelRow>();
  const providers = new Map<string, UsageProviderRow>();
  const jobs = new Map<UsageJob, UsageJobRow>();
  const tasks = new Map<string, UsageTaskRow>();
  const days = new Map<string, UsageDayRow>();
  let fallbackRuns = 0;
  let failedRequests = 0;
  let savedCostUsd: number | undefined;

  // The 30 days, quiet ones included
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(day.getDate() - i);
    days.set(dayKey(day), { date: dayKey(day), tokens: 0, costUsd: 0, calculatedCostUsd: 0, unpricedTokens: 0 });
  }

  for (const entry of entries) {
    const providerName = entry.provider ?? (entry.backend === 'claude' ? 'anthropic' : 'unknown');
    const locality = classify(providerName);
    const tokens = entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
    const pricing = pricingFor(providerName, entry.model, locality === 'local');
    const calculatedCostUsd = pricing ? tokenCostUsd(entry, pricing.rates) : 0;
    const unpricedTokens = pricing ? 0 : tokens;
    if (locality === 'local' && pricing && tokens > 0) savedCostUsd = (savedCostUsd ?? 0) + calculatedCostUsd;
    add(totals, entry, calculatedCostUsd, unpricedTokens);
    add(locality === 'local' ? local : cloud, entry, calculatedCostUsd, unpricedTokens);

    const modelKey = `${providerName}\u0000${entry.model}`;
    let model = models.get(modelKey);
    if (!model) {
      model = {
        ...emptyTotals(), model: entry.model, backend: entry.backend, locality,
        provider: providerName, requests: 0, durationMs: 0, timedOutput: 0,
        ...(pricing ? { pricing } : {}),
      };
      models.set(modelKey, model);
    }
    add(model, entry, calculatedCostUsd, unpricedTokens);
    model.requests += entry.requests ?? 1;
    if (entry.durationMs > 0 && entry.output > 0) {
      model.durationMs += entry.durationMs;
      model.timedOutput += entry.output;
    }

    let provider = providers.get(providerName);
    if (!provider) {
      provider = { ...emptyTotals(), provider: providerName, locality };
      providers.set(providerName, provider);
    }
    add(provider, entry, calculatedCostUsd, unpricedTokens);

    let job = jobs.get(entry.job);
    if (!job) {
      job = { ...emptyTotals(), job: entry.job };
      jobs.set(entry.job, job);
    }
    add(job, entry, calculatedCostUsd, unpricedTokens);

    if (entry.taskId) {
      let task = tasks.get(entry.taskId);
      if (!task) {
        const info = options.tasks?.get(entry.taskId);
        task = {
          ...emptyTotals(), taskId: entry.taskId,
          ...(info?.title ? { title: info.title } : {}),
          ...(info?.reviewRounds !== undefined ? { reviewRounds: info.reviewRounds } : {}),
        };
        tasks.set(entry.taskId, task);
      }
      add(task, entry, calculatedCostUsd, unpricedTokens);
    }

    const at = new Date(entry.at);
    if (!Number.isNaN(at.getTime())) {
      const day = days.get(dayKey(at));
      if (day) {
        day.tokens += tokens;
        day.costUsd += entry.costUsd;
        day.calculatedCostUsd += calculatedCostUsd;
        day.unpricedTokens += unpricedTokens;
      }
    }

    if (entry.fallback) fallbackRuns += 1;
    failedRequests += entry.failures ?? 0;
  }

  for (const model of models.values()) {
    if (model.durationMs > 0) model.tokensPerSecond = model.timedOutput / (model.durationMs / 1000);
  }
  const byModel = [...models.values()].sort(byTotalDesc);

  let chattiest: UsageSummary['facts']['chattiest'];
  let fastest: UsageSummary['facts']['fastest'];
  for (const model of byModel) {
    // Needs enough input to say anything about the ratio
    const sent = model.input + model.cacheRead + model.cacheWrite;
    if (model.output > 0 && sent > 0) {
      const ratio = model.output / sent;
      if (!chattiest || ratio > chattiest.ratio) chattiest = { model: model.model, ratio };
    }
    if (model.tokensPerSecond && (!fastest || model.tokensPerSecond > fastest.tokensPerSecond)) {
      fastest = { model: model.model, tokensPerSecond: model.tokensPerSecond };
    }
  }

  const byTask = [...tasks.values()].sort(byTotalDesc);
  const priciest = [...byTask].filter((t) => t.calculatedCostUsd > 0).sort((a, b) => b.calculatedCostUsd - a.calculatedCostUsd)[0];

  return {
    generatedAt: now.toISOString(),
    entryCount: entries.length,
    totals,
    byModel,
    byProvider: [...providers.values()].sort(byTotalDesc),
    locality: {
      local,
      cloud,
      localShare: totals.total > 0 ? local.total / totals.total : 0,
      ...(savedCostUsd !== undefined ? { savedCostUsd } : {}),
    },
    byJob: [...jobs.values()].sort(byTotalDesc),
    byTask,
    byDay: [...days.values()],
    facts: {
      ...(chattiest ? { chattiest } : {}),
      ...(fastest ? { fastest } : {}),
      ...(priciest ? { priciestTask: { taskId: priciest.taskId, title: priciest.title, calculatedCostUsd: priciest.calculatedCostUsd } } : {}),
      fallbackRuns,
      failedRequests,
    },
  };
}
