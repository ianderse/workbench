/**
 * Usage backfill
 *
 * One-time (and safe to repeat) import of what a project's tasks spent before the ledger existed:
 *
 * - OMP session files: `tasks/<spec>/omp-sessions/*.jsonl` and `previous_runs/<n>/omp-sessions/`.
 *   Every assistant message carries `usage`, `provider`, `model`, its `duration` and a timestamp.
 *   Advisor sessions (a file or folder whose name contains `advisor`) are imported as job `advisor`.
 * - Claude Code transcripts of the tasks' sessions (`claude_run.json` of the task and of
 *   `previous_runs/<n>`), found through `session-spending.ts`; one entry per API request.
 *
 * The job comes from the phase of the task's `claude_run.json` that was running at the time of the
 * message (the last phase that had started), `implement` when that is unknown. Every imported entry
 * is `source: 'backfill'` with a `key` naming session and message, so a second import adds nothing;
 * messages that a live run already recorded (same session, inside the time range that run covered)
 * are skipped as well. All file access is async and streamed.
 */
import path from 'path';
import { createReadStream, promises as fsp } from 'fs';
import { createInterface } from 'readline';
import { appLog } from '../app-logger';
import { DATA_DIR_NAMES } from '../../shared/constants';
import { requestCostUsd, type RequestUsage } from '../claude-code/session-pricing';
import { findSessionTranscript } from '../claude-code/session-spending';
import { appendUsageEntries, readUsageEntries, usageLedgerPath } from './usage-ledger';
import type { UsageEntry, UsageJob } from '../../shared/types/usage';

const BACKFILL_MARKER = 'usage-backfill.json';
const PHASE_JOBS: ReadonlySet<string> = new Set(['plan', 'implement', 'validate', 'revise']);

export interface BackfillOptions {
  /** `.workbench` unless the project says otherwise */
  autoBuildPath?: string;
  /** Claude config dirs to look for transcripts in (default: every known account) */
  configDirs?: string[];
  projectId?: string;
}

export interface BackfillResult {
  added: number;
  /** Messages already in the ledger or covered by a live run */
  skipped: number;
  tasks: number;
}

interface Phase {
  name: string;
  startedMs: number;
}

interface RunFile {
  sessionId?: string;
  backend?: string;
  worktreePath?: string;
  phases: Phase[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

async function readRunFile(file: string): Promise<RunFile | null> {
  const raw = await readJson<{ sessionId?: string; backend?: string; worktreePath?: string; phases?: Array<{ name?: string; startedAt?: string }> }>(file);
  if (!raw) return null;
  const phases: Phase[] = [];
  for (const phase of Array.isArray(raw.phases) ? raw.phases : []) {
    const startedMs = phase?.startedAt ? Date.parse(phase.startedAt) : NaN;
    if (phase?.name && PHASE_JOBS.has(phase.name) && !Number.isNaN(startedMs)) phases.push({ name: phase.name, startedMs });
  }
  phases.sort((a, b) => a.startedMs - b.startedMs);
  return { sessionId: raw.sessionId, backend: raw.backend, worktreePath: raw.worktreePath, phases };
}

/** The phase running at `atMs`: the last one that had started; `implement` when none had */
export function jobAt(phases: readonly Phase[], atMs: number): UsageJob {
  let job: UsageJob = 'implement';
  for (const phase of phases) {
    if (phase.startedMs <= atMs) job = phase.name as UsageJob;
    else break;
  }
  return job;
}

/** Time ranges a live run already recorded, per session */
type Covered = Map<string, Array<[number, number]>>;

function isCovered(covered: Covered, sessionId: string, ms: number): boolean {
  return (covered.get(sessionId) ?? []).some(([from, to]) => ms >= from && ms <= to);
}

async function* jsonLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith('{')) continue;
      try {
        yield JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A line that was still being written
      }
    }
  } finally {
    lines.close();
  }
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

interface Context {
  taskId: string;
  projectId?: string;
  known: Set<string>;
  covered: Covered;
  out: UsageEntry[];
  skipped: number;
}

/** Entries of one OMP session file */
async function readOmpSession(file: string, ctx: Context, run: RunFile | null, advisor: boolean): Promise<void> {
  let sessionId = path.basename(file, '.jsonl');
  try {
    for await (const line of jsonLines(file)) {
      if (line.type === 'session' && typeof line.id === 'string') {
        sessionId = line.id;
        continue;
      }
      if (line.type !== 'message') continue;
      const message = line.message as Record<string, unknown> | undefined;
      if (!message || message.role !== 'assistant') continue;
      const usage = message.usage as Record<string, unknown> | undefined;
      if (!usage || typeof message.model !== 'string') continue;
      const id = typeof line.id === 'string' ? line.id : String(message.timestamp ?? '');
      const key = `omp:${advisor ? 'advisor:' : ''}${sessionId}:${id}`;
      const startedMs = num(message.timestamp) || Date.parse(String(line.timestamp));
      if (ctx.known.has(key) || (!advisor && isCovered(ctx.covered, sessionId, startedMs))) {
        ctx.skipped += 1;
        continue;
      }
      const duration = num(message.duration);
      const endedMs = num(message.completedAt) || (startedMs ? startedMs + duration : Date.now());
      ctx.known.add(key);
      ctx.out.push({
        at: new Date(endedMs).toISOString(),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        taskId: ctx.taskId,
        job: advisor ? 'advisor' : jobAt(run?.phases ?? [], startedMs),
        backend: 'omp',
        ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
        model: message.model,
        input: num(usage.input),
        output: num(usage.output),
        cacheRead: num(usage.cacheRead),
        cacheWrite: num(usage.cacheWrite),
        costUsd: num((usage.cost as Record<string, unknown> | undefined)?.total),
        durationMs: Math.round(duration),
        requests: 1,
        ...(message.stopReason === 'error' ? { failures: 1 } : {}),
        sessionId,
        source: 'backfill',
        key,
      });
    }
  } catch (error) {
    appLog.warn(`[Usage] Could not read the OMP session ${file}:`, error);
  }
}

/** The `*.jsonl` session files in an `omp-sessions` folder, advisor files and folders included */
async function ompSessionFiles(dir: string): Promise<Array<{ file: string; advisor: boolean }>> {
  const found: Array<{ file: string; advisor: boolean }> = [];
  for (const name of await listDir(dir)) {
    const full = path.join(dir, name);
    if (name.endsWith('.jsonl')) {
      found.push({ file: full, advisor: /advisor/i.test(name) });
    } else if (!name.startsWith('.')) {
      // A session's own folder (`<session>/`) keeps its advisor sessions
      for (const inner of await listDir(full)) {
        if (inner.endsWith('.jsonl')) found.push({ file: path.join(full, inner), advisor: /advisor/i.test(inner) || /advisor/i.test(name) });
      }
    }
  }
  return found;
}

/** Entries of one Claude Code transcript: one per API request */
async function readClaudeTranscript(file: string, sessionId: string, ctx: Context, run: RunFile): Promise<void> {
  const counted = new Set<string>();
  try {
    for await (const line of jsonLines(file)) {
      if (line.type !== 'assistant') continue;
      const message = line.message as { id?: string; model?: string; usage?: RequestUsage } | undefined;
      if (!message?.usage || !message.model) continue;
      const request = (typeof line.requestId === 'string' && line.requestId) || message.id;
      if (!request || counted.has(request)) continue;
      counted.add(request);
      const ms = Date.parse(String(line.timestamp));
      const key = `claude:${sessionId}:${request}`;
      if (ctx.known.has(key) || (!Number.isNaN(ms) && isCovered(ctx.covered, sessionId, ms))) {
        ctx.skipped += 1;
        continue;
      }
      const usage = message.usage;
      const written = num(usage.cache_creation_input_tokens);
      ctx.known.add(key);
      ctx.out.push({
        at: Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString(),
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        taskId: ctx.taskId,
        job: jobAt(run.phases, ms),
        backend: 'claude',
        provider: 'anthropic',
        model: message.model,
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: written,
        costUsd: requestCostUsd(message.model, usage),
        durationMs: 0,
        requests: 1,
        sessionId,
        source: 'backfill',
        key,
      });
    }
  } catch (error) {
    appLog.warn(`[Usage] Could not read the Claude Code transcript ${file}:`, error);
  }
}

const running = new Map<string, Promise<BackfillResult>>();

/** Import a project's earlier sessions into its ledger; repeating it adds nothing new */
export function backfillUsage(projectPath: string, options: BackfillOptions = {}): Promise<BackfillResult> {
  const existing = running.get(projectPath);
  if (existing) return existing;
  const run = doBackfill(projectPath, options).finally(() => running.delete(projectPath));
  running.set(projectPath, run);
  return run;
}

async function doBackfill(projectPath: string, options: BackfillOptions): Promise<BackfillResult> {
  const workbench = options.autoBuildPath || '.workbench';
  const ledgerFile = usageLedgerPath(projectPath, workbench);
  const tasksDir = path.join(projectPath, workbench, DATA_DIR_NAMES.tasks);

  const entries = await readUsageEntries(ledgerFile);
  const known = new Set<string>();
  const covered: Covered = new Map();
  for (const entry of entries) {
    if (entry.key) known.add(entry.key);
    if (entry.source !== 'backfill' && entry.sessionId && entry.msFrom && entry.msTo) {
      const ranges = covered.get(entry.sessionId) ?? [];
      ranges.push([entry.msFrom, entry.msTo]);
      covered.set(entry.sessionId, ranges);
    }
  }

  let configDirs = options.configDirs;
  const dirsFor = async (extra?: string) => {
    if (!configDirs) {
      const { claudeConfigDirs } = await import('../claude-profile/profile-config-dirs');
      configDirs = claudeConfigDirs();
    }
    return extra ? [...new Set([extra, ...configDirs])] : configDirs;
  };

  const out: UsageEntry[] = [];
  let skipped = 0;
  let taskCount = 0;

  for (const taskId of await listDir(tasksDir)) {
    const specDir = path.join(tasksDir, taskId);
    // The task's current run, then every run it was started over from
    const runs: Array<{ dir: string }> = [{ dir: specDir }];
    for (const previous of await listDir(path.join(specDir, 'previous_runs'))) runs.push({ dir: path.join(specDir, 'previous_runs', previous) });

    const ctx: Context = { taskId, projectId: options.projectId, known, covered, out: [], skipped: 0 };
    for (const { dir } of runs) {
      const runFile = await readRunFile(path.join(dir, 'claude_run.json'));
      for (const session of await ompSessionFiles(path.join(dir, 'omp-sessions'))) {
        await readOmpSession(session.file, ctx, runFile, session.advisor);
      }
      if (runFile?.sessionId && runFile.backend !== 'omp') {
        const transcript = await findSessionTranscript(runFile.sessionId, await dirsFor(), runFile.worktreePath);
        if (transcript) await readClaudeTranscript(transcript.file, runFile.sessionId, ctx, runFile);
      }
    }
    if (ctx.out.some((entry) => entry.input + entry.output + entry.cacheRead + entry.cacheWrite > 0)) taskCount += 1;
    // Replies without tokens (failed requests) are not written, so they are not counted either
    out.push(...ctx.out.filter((entry) => entry.input + entry.output + entry.cacheRead + entry.cacheWrite > 0));
    skipped += ctx.skipped;
  }

  await appendUsageEntries(ledgerFile, out);
  try {
    await fsp.writeFile(path.join(projectPath, workbench, BACKFILL_MARKER), JSON.stringify({ version: 1, at: new Date().toISOString(), added: out.length }), 'utf-8');
  } catch (error) {
    appLog.warn('[Usage] Could not write the backfill marker:', error);
  }
  return { added: out.length, skipped, tasks: taskCount };
}

/** The import has run for this project */
export async function isUsageBackfilled(projectPath: string, autoBuildPath = '.workbench'): Promise<boolean> {
  try {
    await fsp.access(path.join(projectPath, autoBuildPath, BACKFILL_MARKER));
    return true;
  } catch {
    return false;
  }
}
