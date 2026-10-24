/**
 * Project metrics
 *
 * Spending per project for Settings > Accounts: the sum of every task's Claude Code run cost
 * (`totalCostUsd` in `<specDir>/claude_run.json`) in projects whose `.workbench` directory is
 * initialized. A task that was started over has also spent what its earlier runs cost, so the
 * runs kept under `previous_runs/` count too. Each run's steps carry their own cost and start
 * time, which also gives the project's spending per calendar day for the usage chart.
 *
 * Claude Code is also used on a project without running a task - an agent window, Insights, or
 * `claude` in a terminal - and that spends on the same account. Those sessions are found by the
 * directory they ran in (`claude-code/project-sessions.ts`), together with the ones a window
 * recorded itself (`agent-session-store.ts`), and what each cost per day is read from Claude Code's
 * own transcripts (`claude-code/session-spending.ts`). The sessions a task owns are left to the
 * task's own figures, so nothing is counted twice.
 *
 * The project's transcripts are reconciled together, not one at a time: a Claude Code process
 * writes its running total into every transcript it touches, so several of them can report the
 * same figure, and the total of each `startTime` is counted once across the whole project.
 *
 * A session is read once: what it had spent is kept with it and read again only when its
 * transcript has changed, so a refresh only reads what is new. All file access is async so the
 * main process stays responsive.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { getSpecsDir } from '../shared/constants';
import { appLog } from './app-logger';
import { CLAUDE_RUN_FILE } from './claude-code/task-runner';
import { PREVIOUS_RUNS_DIR } from './task-run-archive';
import {
  cacheAgentSessionSpending,
  readAgentSessions,
  recordFoundSessions,
  type AgentSessionRecord,
  type AgentSessionSpending,
} from './agent-session-store';
import { findProjectSessions } from './claude-code/project-sessions';
import {
  combineSpending,
  dayOf,
  findSessionTranscript,
  readTranscriptSpending,
  spentUsd,
  type SpendingParts,
  type TranscriptFile,
  type TranscriptSpending,
} from './claude-code/session-spending';
import { claudeConfigDirs } from './claude-profile/profile-config-dirs';
import type { ClaudeRunInfo } from '../shared/types/claude-code';
import type { Project, ProjectCostMetrics, ProjectDailyCost } from '../shared/types';

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The run's state, or null when it never ran or its run file is unreadable */
async function readRun(runFile: string): Promise<Partial<ClaudeRunInfo> | null> {
  try {
    return JSON.parse(await fsp.readFile(runFile, 'utf-8')) as Partial<ClaudeRunInfo>;
  } catch {
    return null;
  }
}

function addSpending(byDay: Map<string, number>, day: string, costUsd: number): void {
  byDay.set(day, (byDay.get(day) ?? 0) + costUsd);
}

/**
 * Books one run's cost on the days it was spent: every step on the day it started, and anything
 * the total holds beyond the steps (older runs whose steps carry no cost) on the day the run was
 * last written. Returns what the run cost in total.
 */
function bookRunSpending(run: Partial<ClaudeRunInfo>, byDay: Map<string, number>): number {
  const total = spentUsd(run.totalCostUsd);
  const lastWritten = dayOf(run.updatedAt);
  let booked = 0;

  for (const phase of Array.isArray(run.phases) ? run.phases : []) {
    const costUsd = spentUsd(phase?.costUsd);
    const day = dayOf(phase?.startedAt) ?? lastWritten;
    if (!costUsd || !day) continue;
    addSpending(byDay, day, costUsd);
    booked += costUsd;
  }

  const rest = total - booked;
  if (rest > 0 && lastWritten) addSpending(byDay, lastWritten, rest);
  return total;
}

/** Run files of the runs a task was started over from */
async function previousRunFiles(specDir: string): Promise<string[]> {
  const archive = path.join(specDir, PREVIOUS_RUNS_DIR);
  try {
    const entries = await fsp.readdir(archive, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(archive, entry.name, CLAUDE_RUN_FILE));
  } catch {
    // Never started over
    return [];
  }
}

/** What one task has cost: its current run plus every run it was started over from */
async function readTaskRuns(specDir: string): Promise<Array<Partial<ClaudeRunInfo> | null>> {
  const runFiles = [path.join(specDir, CLAUDE_RUN_FILE), ...(await previousRunFiles(specDir))];
  return Promise.all(runFiles.map(readRun));
}

/** The Claude Code sessions a task's runs own, whose cost the run figures already carry */
function taskSessionIds(runs: Array<Partial<ClaudeRunInfo> | null>): Set<string> {
  const ids = new Set<string>();
  for (const run of runs) {
    if (!run) continue;
    if (run.sessionId) ids.add(run.sessionId);
    for (const phase of Array.isArray(run.phases) ? run.phases : []) {
      if (phase?.sessionId) ids.add(phase.sessionId);
    }
  }
  return ids;
}

/** What a reading kept from last time contributes to the project's spending */
function cachedSpending(cached: AgentSessionSpending | undefined): SpendingParts {
  const empty = { byDay: new Map<string, number>(), total: 0, undated: 0 };
  if (!cached) return { estimate: empty, lastDay: null, runTotals: new Map() };
  if (cached.estimate && cached.runs) {
    return {
      estimate: {
        byDay: new Map(Object.entries(cached.estimate.days ?? {})),
        total: spentUsd(cached.estimate.total),
        undated: spentUsd(cached.estimate.undated),
      },
      lastDay: cached.lastDay ?? null,
      runTotals: new Map(Object.entries(cached.runs)),
    };
  }
  // A reading from before the accountings were kept: the scaled days are all that is left of it, so
  // it stands in as a priced estimate of its own. That cannot be matched against another
  // transcript, but a reading this old only survives once the transcript itself is gone - while the
  // file is still there, `isCurrent()` reads it again to get the accountings back.
  return {
    estimate: {
      byDay: new Map(Object.entries(cached.days ?? {})),
      total: spentUsd(cached.totalCostUsd),
      undated: 0,
    },
    lastDay: null,
    runTotals: new Map(),
  };
}

/** What to keep with a session so the next refresh neither re-reads nor miscounts its transcript */
function toCache(spending: TranscriptSpending, transcript: TranscriptFile): AgentSessionSpending {
  return {
    totalCostUsd: spending.totalCostUsd,
    days: Object.fromEntries(spending.byDay),
    transcript: transcript.file,
    size: transcript.size,
    modifiedMs: transcript.modifiedMs,
    estimate: {
      days: Object.fromEntries(spending.estimate.byDay),
      total: spending.estimate.total,
      undated: spending.estimate.undated,
    },
    lastDay: spending.lastDay,
    runs: Object.fromEntries(spending.runTotals),
  };
}

/**
 * Whether what was read from this transcript last time still describes the file on disk, and holds
 * everything reconciling the project needs. A reading from before the cost accountings were kept
 * with it is read again once, so its total can be recognized in the other transcripts that carry
 * it instead of being added to them.
 */
function isCurrent(cached: AgentSessionSpending | undefined, transcript: TranscriptFile): boolean {
  return (
    !!cached &&
    !!cached.runs &&
    cached.transcript === transcript.file &&
    cached.size === transcript.size &&
    cached.modifiedMs === transcript.modifiedMs
  );
}

/** A session to count, with the transcript it is read from when there still is one */
interface CountableSession {
  session: AgentSessionRecord;
  transcript: TranscriptFile | null;
}

/**
 * The project's Claude Code sessions: the ones its windows recorded, plus every other session that
 * ran in the project and is not a task's. Sessions found for the first time are written to the
 * project's store, so the next refresh reads only the transcripts that changed.
 */
async function countableSessions(project: Project, taskSessions: Set<string>): Promise<CountableSession[]> {
  const recorded = await readAgentSessions(project.path);
  // A session started on one account can end up under another's config dir after a swap
  const configDirs = claudeConfigDirs(recorded.map((session) => session.configDir));
  const countable: CountableSession[] = [];

  for (const session of recorded) {
    // A window that continued a task's session: the task's own figures already carry its cost
    if (taskSessions.has(session.sessionId)) continue;
    countable.push({
      session,
      transcript: await findSessionTranscript(session.sessionId, configDirs, session.cwd),
    });
  }

  const found = await findProjectSessions(project.path, configDirs, {
    skip: new Set([...taskSessions, ...recorded.map((session) => session.sessionId)]),
    skipUnder: [path.join(project.path, project.autoBuildPath || '.workbench', 'worktrees')],
  });
  // Nothing records when a session Workbench did not start began; its last write is all there is
  const records = found.map((session) => ({
    sessionId: session.sessionId,
    configDir: session.configDir,
    cwd: session.cwd,
    startedAt: new Date(session.modifiedMs).toISOString(),
  }));
  countable.push(...records.map((session, index) => ({ session, transcript: found[index] })));
  await recordFoundSessions(project.path, records);

  return countable;
}

/**
 * Books what the project's Claude Code sessions spent on the days they spent it, from their
 * transcripts. Returns their total.
 *
 * The transcripts are read one at a time (a project can hold hundreds of sessions and a transcript
 * can be large), and a session whose transcript has not changed since the last refresh is not read
 * again - what it spent is kept with the session.
 *
 * The readings are reconciled here rather than one by one, because one Claude Code process writes
 * its running total into every transcript it touches: a session that is only part of what that
 * process spent still reports the whole figure, so counting each transcript's total on its own
 * would charge the project for the same dollars twice. `combineSpending()` recognizes the
 * accounting by its `startTime` across the project's transcripts and counts it once.
 */
async function bookSessionSpending(project: Project, taskSessions: Set<string>, byDay: Map<string, number>): Promise<number> {
  const sessions = await countableSessions(project, taskSessions);
  if (sessions.length === 0) return 0;

  const read = new Map<string, AgentSessionSpending>();
  const parts: SpendingParts[] = [];

  for (const { session, transcript } of sessions) {
    const cached = session.spent;
    if (!transcript || isCurrent(cached, transcript)) {
      // Unchanged, or gone: what was read from it last time is what the session spent
      parts.push(cachedSpending(cached));
      continue;
    }
    const spending = await readTranscriptSpending(transcript.file);
    parts.push(spending);
    read.set(session.sessionId, toCache(spending, transcript));
  }

  await cacheAgentSessionSpending(project.path, read);

  const spending = combineSpending(parts);
  for (const [day, costUsd] of spending.byDay) addSpending(byDay, day, costUsd);
  return spending.totalCostUsd;
}

/** Projects whose sessions have been read once since the app started */
const warmed = new Set<string>();

/**
 * Reads a project's sessions once when it is opened, so Metrics is up to date the first time it is
 * looked at rather than reading hundreds of megabytes of transcripts while the user waits. The
 * readings are kept with the sessions, so this runs in the background and only ever does the work
 * once per project; afterwards a refresh reads only what changed. `onWarm` is called when a
 * project's spending has been read, so a Metrics page that is open shows it.
 */
export function warmProjectMetrics(projects: Project[], onWarm: () => void): void {
  const pending = projects.filter((project) => !warmed.has(project.path));
  if (pending.length === 0) return;
  for (const project of pending) warmed.add(project.path);

  void (async () => {
    for (const project of pending) {
      try {
        await getProjectCostMetrics([project]);
        onWarm();
      } catch (error) {
        // Reading again is harmless, so a project that failed may be read on the next refresh
        warmed.delete(project.path);
        appLog.warn(`[ProjectMetrics] Could not read the sessions of ${project.path}:`, error);
      }
    }
  })();
}

/** Spending per day, oldest first; days without spending are left out */
function toDailyCosts(byDay: Map<string, number>): ProjectDailyCost[] {
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, costUsd]) => ({ date, costUsd }));
}

/** Task count, total run cost and spending per day of each initialized project */
export async function getProjectCostMetrics(projects: Project[]): Promise<ProjectCostMetrics[]> {
  const results = await Promise.all(
    projects.map(async (project): Promise<ProjectCostMetrics | null> => {
      const workbenchDir = path.join(project.path, project.autoBuildPath || '.workbench');
      if (!(await isDirectory(workbenchDir))) return null;

      const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
      let specDirs: string[] = [];
      try {
        const entries = await fsp.readdir(specsDir, { withFileTypes: true });
        specDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(specsDir, entry.name));
      } catch {
        // No specs yet
      }

      const runs = (await Promise.all(specDirs.map(readTaskRuns))).flat();
      const byDay = new Map<string, number>();
      const taskCostUsd = runs.reduce((sum, run) => (run ? sum + bookRunSpending(run, byDay) : sum), 0);
      const totalCostUsd = taskCostUsd + (await bookSessionSpending(project, taskSessionIds(runs), byDay));

      return {
        projectId: project.id,
        name: project.name,
        path: project.path,
        taskCount: specDirs.length,
        totalCostUsd,
        daily: toDailyCosts(byDay),
      };
    })
  );
  return results.filter((metrics): metrics is ProjectCostMetrics => metrics !== null);
}
