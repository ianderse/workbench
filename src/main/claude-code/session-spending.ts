/**
 * What one Claude Code session spent, and on which days
 *
 * An agent window runs Claude Code itself, so its cost never reaches a task's `claude_run.json`.
 * Claude Code keeps it in the session transcript instead
 * (`<configDir>/projects/<project>/<sessionId>.jsonl`), in two forms that are read together here:
 *
 * - Every `cost-state` line carries a running total, named after the `startTime` of the cost
 *   accounting it belongs to. Claude Code writes one at a checkpoint and when the session exits,
 *   so it is the authoritative figure but an occasional one, and it carries no timestamp of its
 *   own. That total is *not* per process: Claude Code restores the accounting when a session is
 *   resumed, so the figure keeps climbing over every `--resume` of the session (a task's plan,
 *   implement and validate phases read as one accounting that counts up through all three), and
 *   whichever process holds it writes it into every transcript it goes on to touch, so two
 *   conversations one window worked on both report the same figure. A `startTime` is therefore
 *   worth counting once, at the highest total ever seen for it; adding up what each transcript
 *   reports would count the same dollars as many times as there are transcripts.
 * - Every assistant record carries the tokens its request used, its model and its own timestamp.
 *   Priced per model (`session-pricing.ts`), those give what each turn cost on the day it
 *   happened - including the turns since the last `cost-state` line, which is what makes a session
 *   that is still running show up in the chart after each answer. A turn belongs to the one
 *   transcript it was written in, so turns are simply added up.
 *
 * Reading a transcript therefore yields both: the turns, unscaled, and the highest total each
 * `startTime` reported in it (`TranscriptSpending`). `combineSpending()` reconciles them - the
 * turns divide the spending over the days, the total is whichever of the two is larger, so nothing
 * ever reports less than Claude Code's own figure, and the days are scaled to it. That keeps a
 * conversation resumed weeks later booked on the days it was really spent instead of landing in one
 * lump on the day it was picked up again.
 *
 * Only the caller that holds every transcript of a project (`project-metrics.ts`) can recognize a
 * `startTime` across them, which is why reconciling happens there rather than transcript by
 * transcript. It is done per set of transcripts that share an accounting, though, not over the
 * project in one go: comparing a reported total against an estimate only means anything when both
 * describe the same work, so a session whose turns carry no price must not be weighed against a
 * different session's priced turns.
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

/**
 * What one transcript holds before it is reconciled with the others: the turns as they were priced,
 * and the totals the cost accountings it mentions reported. Kept apart from the reconciled figures
 * because the same accounting can appear in several transcripts and must only be counted once.
 */
export interface SpendingParts {
  estimate: TurnEstimate;
  /** Day of the last record in the transcript, where what has no day of its own is booked */
  lastDay: string | null;
  /** Highest total each cost accounting reported here, by the key `runKey()` gives it */
  runTotals: Map<string, number>;
}

/** A transcript's own reconciled spending, together with what the project needs to reconcile it */
export interface TranscriptSpending extends SessionSpending, SpendingParts {}

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
export interface TurnEstimate {
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
 * The key a cost accounting is counted under. Its `startTime` names it across transcripts, which
 * is what lets the same accounting be recognized in two of them. A line that carries no usable
 * `startTime` cannot be matched that way, so the transcript it was found in stands in for it: the
 * total is still counted, but only against this one transcript, where it cannot wrongly displace
 * another transcript's unknown accounting or be silently merged with it.
 *
 * A `cost-state` line also carries a `sessionId`, and it is deliberately not the key: in every
 * transcript examined it simply repeats the transcript's own name, so it says which conversation
 * the line was written in, not which accounting the money belongs to. Keying on it would be the
 * same as not deduplicating at all.
 *
 * `startTime` is a millisecond stamp, so two unrelated processes starting in the same millisecond
 * would be merged and the smaller total dropped. Measured against the sessions on this machine
 * (352 transcripts across both config dirs) that case does not appear: there are two shared
 * `startTime` values, and both behave as one accounting whose running total was written into two
 * conversations - $14.40 beside $0.41 for a 32-second conversation the same process ran first, and
 * $49.75 beside $49.68. In both the larger figure already covers the smaller, which is what makes
 * the highest total per accounting the right answer and summing them the wrong one.
 */
export function runKey(startTime: unknown, file: string): string {
  return typeof startTime === 'number' && startTime > 0 ? `run:${startTime}` : `file:${file}`;
}

/**
 * What the transcript says the session has spent, per day: the turns priced per model, scaled so
 * the session's total is never below what Claude Code itself last reported. The unscaled turns and
 * the totals Claude Code reported come back along with it, for a caller that holds several
 * transcripts and has to reconcile them together.
 *
 * A transcript that cannot be read through (deleted, replaced, out of file handles) gives up what
 * it has read so far rather than failing the whole of Metrics.
 */
export async function readTranscriptSpending(file: string): Promise<TranscriptSpending> {
  /** Highest total each cost accounting has reported in this transcript */
  const runTotals = new Map<string, number>();
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
          const run = runKey(data.startTime, file);
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

  const parts: SpendingParts = { estimate, lastDay: dayOf(lastTimestamp), runTotals };
  return { ...combineSpending([parts]), ...parts };
}

/**
 * The spending of one or more transcripts per day: what their turns are estimated to have cost,
 * scaled to the total the cost accountings reported when that is higher (it covers work the turns
 * do not price, such as a model with no published price). Each accounting counts once, at the
 * highest total it reported in any of the transcripts, so a figure one process wrote into several
 * of them is not counted again per transcript.
 *
 * When no turn could be priced, the reported total is booked on the last day any of the transcripts
 * was written on, which is all that is known about it.
 */
export function combineSpending(parts: Iterable<SpendingParts>): SessionSpending {
  const byDay = new Map<string, number>();
  let totalCostUsd = 0;

  for (const group of groupBySharedAccounting([...parts])) {
    const reconciled = reconcileGroup(group);
    totalCostUsd += reconciled.totalCostUsd;
    for (const [day, costUsd] of reconciled.byDay) byDay.set(day, (byDay.get(day) ?? 0) + costUsd);
  }

  return { totalCostUsd, byDay };
}

/**
 * The transcripts split into the sets that have to be reconciled together: two transcripts belong
 * to the same set when a cost accounting wrote into both, directly or through a chain of others.
 *
 * Reconciling the whole project in one go would be wrong, because `Math.max` is only meaningful
 * between two measurements of the *same* work. A session Claude Code could not price (a model with
 * no published price prices its turns at nothing) reports a total and no estimate; a session that
 * is still running has priced turns and has not written a total yet. Compared across the project,
 * the first one's total would swallow the second one's turns - the money would go missing from the
 * total and, worse, be smeared over days the first session never ran on. Compared within a set,
 * each is reconciled against its own work, and an accounting that reached several transcripts is
 * still only counted once.
 */
function groupBySharedAccounting(all: SpendingParts[]): SpendingParts[][] {
  // Union-find over the transcripts, joined by every accounting key they have in common
  const parent = all.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const firstHolder = new Map<string, number>();
  all.forEach((part, index) => {
    for (const run of part.runTotals.keys()) {
      const holder = firstHolder.get(run);
      if (holder === undefined) firstHolder.set(run, index);
      else union(holder, index);
    }
  });

  const sets = new Map<number, SpendingParts[]>();
  all.forEach((part, index) => {
    const root = find(index);
    const set = sets.get(root);
    if (set) set.push(part);
    else sets.set(root, [part]);
  });
  return [...sets.values()];
}

/**
 * What one such set spent per day: its turns priced per model, scaled to the total its accountings
 * reported when that is higher (which covers work the turns do not price), with each accounting
 * counted once at the highest total it reported in any of the set's transcripts.
 */
function reconcileGroup(group: SpendingParts[]): SessionSpending {
  const byDay = new Map<string, number>();
  const runTotals = new Map<string, number>();
  let estimated = 0;
  let lastDay: string | null = null;

  for (const part of group) {
    estimated += part.estimate.total;
    for (const [day, costUsd] of part.estimate.byDay) byDay.set(day, (byDay.get(day) ?? 0) + costUsd);
    // Turns with no readable day belong to the transcript they were read from, not to the newest one
    if (part.estimate.undated > 0 && part.lastDay) {
      byDay.set(part.lastDay, (byDay.get(part.lastDay) ?? 0) + part.estimate.undated);
    }
    for (const [run, total] of part.runTotals) {
      if (total > (runTotals.get(run) ?? 0)) runTotals.set(run, total);
    }
    if (part.lastDay && (!lastDay || part.lastDay > lastDay)) lastDay = part.lastDay;
  }

  const reported = [...runTotals.values()].reduce((sum, total) => sum + total, 0);
  const totalCostUsd = Math.max(estimated, reported);

  if (estimated <= 0) {
    const onLastDay = new Map<string, number>();
    if (totalCostUsd > 0 && lastDay) onLastDay.set(lastDay, totalCostUsd);
    return { totalCostUsd, byDay: onLastDay };
  }

  const scale = totalCostUsd / estimated;
  for (const [day, costUsd] of byDay) byDay.set(day, costUsd * scale);
  return { totalCostUsd, byDay };
}
