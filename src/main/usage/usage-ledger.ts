/**
 * Usage ledger
 *
 * `<project>/.workbench/usage.jsonl`: append-only, one JSON line per model per run (`UsageEntry`).
 * Appending is async and never throws into the caller (a failed write is logged); writes to one
 * file are queued so lines never interleave. Reading is async and cached until the file changes.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { appLog } from '../app-logger';
import { USAGE_JOBS, type UsageBackend, type UsageEntry, type UsageJob } from '../../shared/types/usage';

export const USAGE_LEDGER_FILE = 'usage.jsonl';

/** The ledger of a project, given the project's directory (`autoBuildPath` is `.workbench` unless set) */
export function usageLedgerPath(projectPath: string, autoBuildPath = '.workbench'): string {
  return path.join(projectPath, autoBuildPath, USAGE_LEDGER_FILE);
}

/** The ledger next to a task's folder (`<project>/.workbench/tasks/<spec>` -> `<project>/.workbench/usage.jsonl`) */
export function usageLedgerForSpecDir(specDir: string): string {
  return path.join(path.dirname(path.dirname(specDir)), USAGE_LEDGER_FILE);
}

const queues = new Map<string, Promise<void>>();
const listeners = new Set<(ledgerFile: string) => void>();

/** Called after lines were appended to a ledger */
export function onUsageLedgerChanged(listener: (ledgerFile: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A usable entry, or null when the line is not one */
export function normalizeUsageEntry(raw: unknown): UsageEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.model !== 'string' || !r.model || typeof r.at !== 'string') return null;
  const job = USAGE_JOBS.includes(r.job as UsageJob) ? (r.job as UsageJob) : 'other';
  const backend: UsageBackend = r.backend === 'omp' ? 'omp' : 'claude';
  const entry: UsageEntry = {
    at: r.at,
    job,
    backend,
    model: r.model,
    input: toNumber(r.input),
    output: toNumber(r.output),
    cacheRead: toNumber(r.cacheRead),
    cacheWrite: toNumber(r.cacheWrite),
    costUsd: toNumber(r.costUsd),
    durationMs: toNumber(r.durationMs),
  };
  for (const key of ['projectId', 'taskId', 'provider', 'runId', 'sessionId', 'key'] as const) {
    if (typeof r[key] === 'string' && r[key]) entry[key] = r[key] as string;
  }
  for (const key of ['requests', 'failures', 'msFrom', 'msTo'] as const) {
    if (toNumber(r[key])) entry[key] = toNumber(r[key]);
  }
  if (r.fallback === true) entry.fallback = true;
  if (r.source === 'backfill') entry.source = 'backfill';
  return entry;
}

/** Append entries to a ledger (async, queued); resolves when written, never rejects */
export function appendUsageEntries(ledgerFile: string, entries: UsageEntry[]): Promise<void> {
  const lines = entries.filter((entry) => entry.input + entry.output + entry.cacheRead + entry.cacheWrite > 0);
  if (lines.length === 0) return Promise.resolve();
  const text = `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const previous = queues.get(ledgerFile) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await fsp.mkdir(path.dirname(ledgerFile), { recursive: true });
      await fsp.appendFile(ledgerFile, text, 'utf-8');
      for (const listener of listeners) {
        try {
          listener(ledgerFile);
        } catch (error) {
          appLog.warn('[Usage] Ledger listener failed:', error);
        }
      }
    } catch (error) {
      appLog.warn(`[Usage] Could not append to ${ledgerFile}:`, error);
    }
  });
  queues.set(ledgerFile, next);
  void next.then(() => {
    if (queues.get(ledgerFile) === next) queues.delete(ledgerFile);
  });
  return next;
}

const readCache = new Map<string, { size: number; mtimeMs: number; entries: UsageEntry[] }>();

/** Every entry of a ledger (a missing file is an empty ledger); cached until the file changes */
export async function readUsageEntries(ledgerFile: string): Promise<UsageEntry[]> {
  // Let queued appends land first, so a read right after a write sees it
  await queues.get(ledgerFile);
  let stats;
  try {
    stats = await fsp.stat(ledgerFile);
  } catch {
    readCache.delete(ledgerFile);
    return [];
  }
  const cached = readCache.get(ledgerFile);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.entries;

  const entries: UsageEntry[] = [];
  try {
    const text = await fsp.readFile(ledgerFile, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = normalizeUsageEntry(JSON.parse(line));
        if (entry) entries.push(entry);
      } catch {
        // A line that was still being written
      }
    }
  } catch (error) {
    appLog.warn(`[Usage] Could not read ${ledgerFile}:`, error);
    return cached?.entries ?? [];
  }
  readCache.set(ledgerFile, { size: stats.size, mtimeMs: stats.mtimeMs, entries });
  return entries;
}
