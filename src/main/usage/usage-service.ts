/**
 * Usage service: the cached summary of a project's ledger for the Usage page
 *
 * The summary is kept per project and recomputed when the ledger changes, when the user asks for a
 * refresh, or after a rebuild. The first time the page is opened for a project, the earlier sessions
 * of its tasks are imported (usage-backfill.ts); "Rebuild from history" runs that import again.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { appLog } from '../app-logger';
import { DATA_DIR_NAMES } from '../../shared/constants';
import type { UsageSummary, UsageSummaryResult } from '../../shared/types/usage';
import { backfillUsage, isUsageBackfilled } from './usage-backfill';
import { classifyProvider, readProviderBaseUrls } from './provider-locality';
import { onUsageLedgerChanged, readUsageEntries, usageLedgerPath } from './usage-ledger';
import { summarizeUsage } from './usage-summary';
import { readOmpPricingModels } from './omp-pricing';

export interface UsageProject {
  id: string;
  path: string;
  autoBuildPath?: string;
}

export type UsageSummaryMode = 'cached' | 'refresh' | 'rebuild';

const cache = new Map<string, UsageSummary>();

onUsageLedgerChanged((ledgerFile) => {
  for (const key of [...cache.keys()]) {
    if (usageLedgerPath(key.split('\u0000')[0], key.split('\u0000')[1]) === ledgerFile) cache.delete(key);
  }
});

/** Title and AI review rounds of the tasks that appear in the ledger */
async function readTaskInfo(project: UsageProject, taskIds: string[]): Promise<Map<string, { title?: string; reviewRounds?: number }>> {
  const tasksDir = path.join(project.path, project.autoBuildPath || '.workbench', DATA_DIR_NAMES.tasks);
  const info = new Map<string, { title?: string; reviewRounds?: number }>();
  await Promise.all(taskIds.map(async (taskId) => {
    const dir = path.join(tasksDir, taskId);
    const read = async (file: string): Promise<Record<string, unknown> | null> => {
      try {
        return JSON.parse(await fsp.readFile(path.join(dir, file), 'utf-8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const [plan, run] = await Promise.all([read('implementation_plan.json'), read('claude_run.json')]);
    const triage = run?.triage as { title?: unknown } | undefined;
    const title = (typeof plan?.feature === 'string' && plan.feature) || (typeof triage?.title === 'string' && triage.title) || undefined;
    const rounds = Array.isArray(run?.reviewRounds) ? run.reviewRounds.length : undefined;
    if (title || rounds !== undefined) info.set(taskId, { ...(title ? { title } : {}), ...(rounds !== undefined ? { reviewRounds: rounds } : {}) });
  }));
  return info;
}

export async function getUsageSummary(project: UsageProject, mode: UsageSummaryMode = 'cached'): Promise<UsageSummaryResult> {
  const cacheKey = `${project.path}\u0000${project.autoBuildPath || '.workbench'}`;
  let backfilled = await isUsageBackfilled(project.path, project.autoBuildPath);

  if (mode === 'rebuild' || !backfilled) {
    try {
      const result = await backfillUsage(project.path, { autoBuildPath: project.autoBuildPath, projectId: project.id });
      appLog.info(`[Usage] Imported ${result.added} entries from ${result.tasks} tasks of ${project.path} (${result.skipped} already known)`);
      backfilled = true;
      cache.delete(cacheKey);
    } catch (error) {
      appLog.warn(`[Usage] Backfill failed for ${project.path}:`, error);
    }
  }

  const cached = cache.get(cacheKey);
  if (cached && mode === 'cached') return { summary: cached, backfilled };

  const [entries, baseUrls, pricingModels] = await Promise.all([
    readUsageEntries(usageLedgerPath(project.path, project.autoBuildPath)),
    readProviderBaseUrls(),
    readOmpPricingModels(mode !== 'cached'),
  ]);
  const taskIds = [...new Set(entries.map((entry) => entry.taskId).filter((id): id is string => !!id))];
  const summary = summarizeUsage(entries, {
    classify: (provider) => classifyProvider(provider, baseUrls),
    tasks: await readTaskInfo(project, taskIds),
    pricingModels,
  });
  cache.set(cacheKey, summary);
  return { summary, backfilled };
}
