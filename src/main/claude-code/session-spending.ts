/**
 * What one Claude Code session spent, and on which days
 *
 * An agent window runs Claude Code itself, so its cost never reaches a task's `claude_run.json`.
 * Claude Code keeps it in the session transcript instead
 * (`<configDir>/projects/<project>/<sessionId>.jsonl`), in two forms that are read together here:
 *
 * - Every `cost-state` line carries the running total of the process that wrote it. Claude Code
 *   writes one at a checkpoint and when the session exits, so it is the authoritative figure but
 *   an occasional one, and it carries no timestamp of its own. Each process run (`startTime`) is
 *   followed separately and the runs are added up: a run reports only what it spent itself, and a
 *   resumed session starts counting at zero again.
 * - Every assistant record carries the tokens its request used, its model and its own timestamp.
 *   Priced per model (`session-pricing.ts`), those give what each turn cost on the day it
 *   happened - including the turns since the last `cost-state` line, which is what makes a session
 *   that is still running show up in the chart after each answer.
 *
 * The turns divide the session's spending over the days; the total is whichever of the two is
 * larger, so a session never reports less than Claude Code's own figure, and the days are scaled
 * to it. That keeps a conversation resumed weeks later booked on the days it was really spent
 * instead of landing in one lump on the day it was picked up again.
 *
 * One API response is written to the transcript as several records (one per content block), all
 * repeating the same usage, so requests are counted once by their request id.
 */
import path from 'path';
import { createReadStream, promises as fsp } from 'fs';
import { createInterface } from 'readline';
import { getSessionFilePath } from '../claude-profile/session-utils';
import { requestCostUsd, type RequestUsage } from './session-pricing';
import { appLog } from '../app-logger';

/** What a session cost in total, and what it cost on each local calendar day (`YYYY-MM-DD`) */
export interface SessionSpending {
  totalCostUsd: number;
  byDay: Map<string, number>;
}

/** A session's transcript as it is on disk, which says whether a reading of it is still current */
export interface TranscriptFile {
  file: string;
  size: number;
  modifiedMs: number;
}

/** Only these lines are parsed; everything else in a transcript is skipped by a string test */
const COST_STATE = '"cost-state"';
const ASSISTANT = '"assistant"';
const USAGE_KEY = '"usage"';
const TIMESTAMP_KEY = '"timestamp":"';
/** The record's own timestamp, matched strictly so JSON quoted inside a tool result can't pose as it */
const TIMESTAMP = /"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/g;

interface CostStateLine {
  type?: string;
  /** When the process that wrote the line started (epoch ms) */
  startTime?: number;
  totalCostUSD?: number;
}

interface AssistantLine {
  type?: string;
  timestamp?: string;
  /** Claude Code writes one record per content block, all from the same API request */
  requestId?: string;
  message?: { id?: string; model?: string; usage?: RequestUsage };
}

/** A cost that can be booked: a finite, positive number */
export function spentUsd(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Local calendar day of a timestamp (`YYYY-MM-DD`), or null when it is missing or unparsable */
export function dayOf(timestamp: string | number | undefined): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The timestamp a transcript line carries, read without parsing the whole line.
 *
 * A line can hold more than one: a tool result that echoes JSON brings its own along. Transcripts
 * are written in order, so the record's own timestamp is the latest one in the line that is not
 * behind the line before it, and never in the future.
 */
function timestampOf(line: string, previous: string | undefined, now: string): string | undefined {
  if (!line.includes(TIMESTAMP_KEY)) return undefined;
  let latest: string | undefined;
  for (const match of line.matchAll(TIMESTAMP)) {
    const found = match[1];
    if (found > now) continue;
    if (previous && found < previous) continue;
    if (!latest || found > latest) latest = found;
  }
  return latest;
}

/** A transcript together with the session it belongs to and the account it was written under */
export interface SessionTranscript extends TranscriptFile {
  sessionId: string;
  configDir: string;
}

/**
 * The session Claude Code was last writing in a working directory, which is the one `--continue`
 * would pick up. Restoring an agent window resumes it by id instead, so what it goes on to spend
 * is recorded against the project (`agent-session-store.ts`). Sessions in `exclude` are skipped,
 * so two windows restored together do not both land in the same conversation.
 */
export async function latestTranscript(
  configDirs: string[],
  cwd: string,
  exclude?: ReadonlySet<string>
): Promise<SessionTranscript | null> {
  let latest: SessionTranscript | null = null;

  for (const dir of configDirs) {
    // Claude Code names the folder after the working directory
    const folder = path.dirname(getSessionFilePath(dir, cwd, 'session'));
    let entries: string[];
    try {
      entries = await fsp.readdir(folder);
    } catch {
      // Nothing has run in this directory on this account
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      if (exclude?.has(sessionId)) continue;
      const file = path.join(folder, entry);
      try {
        const stats = await fsp.stat(file);
        if (!stats.isFile()) continue;
        if (latest && stats.mtimeMs <= latest.modifiedMs) continue;
        latest = {
          sessionId,
          configDir: dir,
          file,
          size: stats.size,
          modifiedMs: stats.mtimeMs,
        };
      } catch {
        // Removed while the folder was being read
      }
    }
  }
  return latest;
}

/**
 * The transcript of a session: where the window ran it first (Claude Code names the folder after
 * the working directory), then every config dir, because a profile swap moves the transcript.
 */
export async function findSessionTranscript(
  sessionId: string,
  configDirs: string[],
  cwd?: string
): Promise<TranscriptFile | null> {
  const described = async (file: string): Promise<TranscriptFile | null> => {
    try {
      const stats = await fsp.stat(file);
      return stats.isFile() ? { file, size: stats.size, modifiedMs: stats.mtimeMs } : null;
    } catch {
      return null;
    }
  };

  if (cwd) {
    for (const dir of configDirs) {
      const known = await described(getSessionFilePath(dir, cwd, sessionId));
      if (known) return known;
    }
  }

  // The session moved, or it ran somewhere else: look through the projects of every config dir
  for (const dir of configDirs) {
    let projects: string[];
    try {
      projects = await fsp.readdir(path.join(dir, 'projects'));
    } catch {
      // This config dir has no sessions
      continue;
    }
    for (const project of projects) {
      const found = await described(path.join(dir, 'projects', project, `${sessionId}.jsonl`));
      if (found) return found;
    }
  }
  return null;
}

/** What the turns of a transcript are estimated to have cost, per day */
interface TurnEstimate {
  byDay: Map<string, number>;
  total: number;
  /** Turns whose day could not be read, booked on the session's last day */
  undated: number;
}

/**
 * Books the cost of one assistant record. A record repeats the usage of the request it belongs to,
 * so only the first record of each request counts.
 */
function bookTurn(line: AssistantLine, fallbackDay: string | null, counted: Set<string>, estimate: TurnEstimate): void {
  if (line.type !== 'assistant') return;
  const request = line.requestId || line.message?.id;
  if (request) {
    if (counted.has(request)) return;
    counted.add(request);
  }

  const costUsd = requestCostUsd(line.message?.model, line.message?.usage);
  if (costUsd <= 0) return;
  estimate.total += costUsd;

  const day = dayOf(line.timestamp) ?? fallbackDay;
  if (day) estimate.byDay.set(day, (estimate.byDay.get(day) ?? 0) + costUsd);
  else estimate.undated += costUsd;
}

/**
 * What the transcript says the session has spent, per day: the turns priced per model, scaled so
 * the session's total is never below what Claude Code itself last reported.
 *
 * A transcript that cannot be read through (deleted, replaced, out of file handles) gives up what
 * it has read so far rather than failing the whole of Metrics.
 */
export async function readTranscriptSpending(file: string): Promise<SessionSpending> {
  /** Highest total each process run has reported */
  const runTotals = new Map<number, number>();
  const estimate: TurnEstimate = { byDay: new Map(), total: 0, undated: 0 };
  const counted = new Set<string>();
  let lastTimestamp: string | undefined;
  const now = new Date().toISOString();

  try {
    const lines = createInterface({
      input: createReadStream(file, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        const timestamp = timestampOf(line, lastTimestamp, now);
        if (timestamp) lastTimestamp = timestamp;

        if (line.includes(COST_STATE)) {
          let data: CostStateLine;
          try {
            data = JSON.parse(line) as CostStateLine;
          } catch {
            // A line that was still being written
            continue;
          }
          if (data.type !== 'cost-state') continue;
          const run = typeof data.startTime === 'number' ? data.startTime : 0;
          const total = spentUsd(data.totalCostUSD);
          if (total > (runTotals.get(run) ?? 0)) runTotals.set(run, total);
          continue;
        }

        if (!line.includes(ASSISTANT) || !line.includes(USAGE_KEY)) continue;
        try {
          bookTurn(JSON.parse(line) as AssistantLine, dayOf(lastTimestamp), counted, estimate);
        } catch {
          // A line that was still being written
        }
      }
    } finally {
      lines.close();
    }
  } catch (error) {
    appLog.warn(`[SessionSpending] Could not read the session transcript ${file}:`, error);
  }

  return combine(estimate, runTotals, dayOf(lastTimestamp));
}

/**
 * The session's spending per day: what the turns are estimated to have cost, scaled to the total
 * the runs reported when that is higher (it covers work the turns do not price, such as a model
 * with no published price). When no turn could be priced, the reported total is booked on the
 * session's last day, which is all that is known about it.
 */
function combine(estimate: TurnEstimate, runTotals: Map<number, number>, lastDay: string | null): SessionSpending {
  const reported = [...runTotals.values()].reduce((sum, total) => sum + total, 0);
  const totalCostUsd = Math.max(estimate.total, reported);
  const byDay = new Map<string, number>();

  if (estimate.total <= 0) {
    if (totalCostUsd > 0 && lastDay) byDay.set(lastDay, totalCostUsd);
    return { totalCostUsd, byDay };
  }

  const scale = totalCostUsd / estimate.total;
  for (const [day, costUsd] of estimate.byDay) byDay.set(day, costUsd * scale);
  if (estimate.undated > 0 && lastDay) {
    byDay.set(lastDay, (byDay.get(lastDay) ?? 0) + estimate.undated * scale);
  }
  return { totalCostUsd, byDay };
}
