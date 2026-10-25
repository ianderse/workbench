/**
 * Recording a finished run in the usage ledger
 *
 * The process wrappers (`startClaudeProcess`, `startOmpProcess`) take an optional `UsageContext`
 * (which job this run is, which task, which project) and call these when the run ends. Claude Code
 * reports tokens per model in its `result` message (`modelUsage`); OMP's translator sums them per
 * provider and model over the run's replies (`omp_usage`). Everything here is fire-and-forget.
 */
import type { ClaudeResultMessage, OmpModelUsage } from '../claude-code/stream-types';
import type { UsageEntry, UsageJob } from '../../shared/types/usage';
import { appendUsageEntries, usageLedgerForSpecDir, usageLedgerPath } from './usage-ledger';

/** Who a run's tokens are booked to */
export interface UsageContext {
  /** The project's `usage.jsonl` */
  ledgerFile: string;
  job: UsageJob;
  projectId?: string;
  /** Task folder name (spec id) */
  taskId?: string;
  runId?: string;
}

/** Context for a run that belongs to a project (by its directory) */
export function projectUsage(projectPath: string | undefined, job: UsageJob, extra: Partial<Omit<UsageContext, 'ledgerFile' | 'job'>> = {}): UsageContext | undefined {
  return projectPath ? { ledgerFile: usageLedgerPath(projectPath), job, ...extra } : undefined;
}

/** Context for a run of a task, by the task's folder */
export function taskUsage(specDir: string, job: UsageJob, specId: string, projectId?: string): UsageContext {
  return { ledgerFile: usageLedgerForSpecDir(specDir), job, taskId: specId, projectId };
}

function base(ctx: UsageContext): Pick<UsageEntry, 'job' | 'projectId' | 'taskId' | 'runId'> {
  return {
    job: ctx.job,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  };
}

/** Ledger entries of an OMP run, one per model */
export function ompUsageEntries(ctx: UsageContext, rows: ReadonlyArray<OmpModelUsage>, meta: { sessionId?: string; at?: Date } = {}): UsageEntry[] {
  const at = (meta.at ?? new Date()).toISOString();
  return rows.map((row) => ({
    at,
    ...base(ctx),
    backend: 'omp' as const,
    ...(row.provider ? { provider: row.provider } : {}),
    model: row.model,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    costUsd: row.costUsd,
    durationMs: Math.round(row.durationMs),
    requests: row.requests,
    ...(row.failures ? { failures: row.failures } : {}),
    ...(row.fallback ? { fallback: true } : {}),
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    ...(row.msFrom ? { msFrom: row.msFrom } : {}),
    ...(row.msTo ? { msTo: row.msTo } : {}),
  }));
}

/** Ledger entries of a Claude Code run, one per model in its `modelUsage` */
export function claudeUsageEntries(ctx: UsageContext, result: ClaudeResultMessage, startedMs?: number, at: Date = new Date()): UsageEntry[] {
  const models = Object.entries(result.modelUsage ?? {});
  const sessionId = result.session_id || undefined;
  const entries: UsageEntry[] = models.map(([model, usage]) => ({
    at: at.toISOString(),
    ...base(ctx),
    backend: 'claude' as const,
    provider: 'anthropic',
    model,
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadInputTokens ?? 0,
    cacheWrite: usage.cacheCreationInputTokens ?? 0,
    costUsd: usage.costUSD ?? 0,
    // The run's wall time only says something about the model when it was the only one
    durationMs: models.length === 1 ? Math.round(result.duration_ms ?? 0) : 0,
    requests: 1,
    ...(sessionId ? { sessionId } : {}),
    // The time the run covered, so a later backfill of the session transcript skips these requests
    ...(startedMs ? { msFrom: startedMs, msTo: at.getTime() } : {}),
  }));
  return entries;
}

/** Book an OMP run's tokens; never throws or waits for the disk */
export function recordOmpUsage(ctx: UsageContext | undefined, rows: ReadonlyArray<OmpModelUsage>, meta: { sessionId?: string } = {}): void {
  if (!ctx || rows.length === 0) return;
  void appendUsageEntries(ctx.ledgerFile, ompUsageEntries(ctx, rows, meta));
}

/** Book a Claude Code run's tokens; never throws or waits for the disk */
export function recordClaudeUsage(ctx: UsageContext | undefined, result: ClaudeResultMessage | undefined, startedMs?: number): void {
  if (!ctx || !result) return;
  void appendUsageEntries(ctx.ledgerFile, claudeUsageEntries(ctx, result, startedMs));
}
