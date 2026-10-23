/**
 * Keeping Metrics up to date while a window is spending
 *
 * Settings > Accounts > Metrics shows what it read last and reads again on Refresh. An agent
 * window, though, goes on spending while the page is open: Claude Code appends to the session's
 * transcript on every answer, and the figures on the page are stale from then on. While the page
 * is open it asks for a watch (`PROJECT_METRICS_WATCH`), and this watches what Metrics is read
 * from - each project's `.workbench` directory, where the sessions of its windows are recorded,
 * and the transcripts of those sessions - and reports a change once the writes settle, so the page
 * reads the projects again by itself.
 *
 * The watch costs one file watcher per session and is dropped as soon as the page is closed.
 * Watchers never keep the app alive (`persistent: false`), and a window that starts a new session
 * joins the watch when the list is armed again. Paths inside WSL (`\\wsl.localhost\...`, a
 * project there or the WSL Claude home) are polled: fs.watch doesn't work on them.
 */
import path from 'path';
import { unwatchFile, watch, watchFile, type Stats } from 'fs';
import { readAgentSessions, type AgentSessionRecord } from './agent-session-store';
import { findSessionTranscript } from './claude-code/session-spending';
import { claudeConfigDirs } from './claude-profile/profile-config-dirs';
import { appLog } from './app-logger';
import { isWslUncPath } from './platform/wsl-paths';
import type { Project } from '../shared/types';

/** One answer causes a burst of writes; report the change once they settle */
const SETTLE_MS = 1500;
/** At most this many sessions per project, the most recently written - a project can hold far more */
const WATCHED_SESSIONS = 24;
/** How often the list of watched files may be built again */
const REARM_MS = 60_000;
/** How often a path inside WSL is checked for changes */
const POLL_MS = 2000;
/** What a project's windows record their sessions in, inside its `.workbench` (agent-session-store.ts) */
const AGENT_SESSIONS_FILE = 'agent-sessions.json';

interface Watch {
  projects: Project[];
  onChange: () => void;
}

/** Stops each watcher */
let watchers: Array<() => void> = [];
let settling: NodeJS.Timeout | null = null;
let armedAt = 0;
let active: Watch | null = null;

/** Watch what the given projects' metrics are read from, dropping any watch already in place */
export async function watchProjectMetrics(projects: Project[], onChange: () => void): Promise<void> {
  stopWatchingProjectMetrics();
  active = { projects, onChange };
  await arm();
}

/** Drop the watch (the page that asked for it is gone) */
export function stopWatchingProjectMetrics(): void {
  active = null;
  if (settling) clearTimeout(settling);
  settling = null;
  closeWatchers();
}

function closeWatchers(): void {
  for (const close of watchers) {
    try {
      close();
    } catch {
      // Already closed
    }
  }
  watchers = [];
}

/** Watch each project's own directory and the transcripts of the sessions its windows started */
async function arm(): Promise<void> {
  const watched = active;
  if (!watched) return;
  armedAt = Date.now();

  for (const project of watched.projects) {
    if (active !== watched) return;
    const dataDir = path.join(project.path, project.autoBuildPath || '.workbench');
    addWatcher(dataDir);
    // Polling a directory only sees entries come and go, not a file in it being rewritten
    if (isWslUncPath(dataDir)) addWatcher(path.join(dataDir, AGENT_SESSIONS_FILE));

    const sessions = recentSessions(await readAgentSessions(project.path));
    if (sessions.length === 0) continue;
    const configDirs = claudeConfigDirs(sessions.map((session) => session.configDir));
    for (const session of sessions) {
      if (active !== watched) return;
      const transcript = await findSessionTranscript(session.sessionId, configDirs, session.cwd);
      if (transcript) addWatcher(transcript.file);
    }
  }
}

/** The sessions worth following: the ones whose transcript was written to last */
function recentSessions(sessions: AgentSessionRecord[]): AgentSessionRecord[] {
  const writtenAt = (session: AgentSessionRecord): number => {
    if (typeof session.spent?.modifiedMs === 'number') return session.spent.modifiedMs;
    const started = Date.parse(session.startedAt);
    return Number.isNaN(started) ? 0 : started;
  };
  return [...sessions].sort((a, b) => writtenAt(b) - writtenAt(a)).slice(0, WATCHED_SESSIONS);
}

function addWatcher(target: string): void {
  if (isWslUncPath(target)) {
    const listener = (current: Stats, previous: Stats) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) reportChange();
    };
    watchFile(target, { persistent: false, interval: POLL_MS }, listener);
    watchers.push(() => unwatchFile(target, listener));
    return;
  }
  try {
    const watcher = watch(target, { persistent: false }, () => reportChange());
    // A watched file that is replaced or removed takes its watcher with it
    watcher.on('error', () => {
      try {
        watcher.close();
      } catch {
        // Already closed
      }
    });
    watchers.push(() => watcher.close());
  } catch {
    // Nothing to watch here yet (a project that was never initialized, a transcript just moved)
  }
}

function reportChange(): void {
  if (settling || !active) return;
  settling = setTimeout(() => {
    settling = null;
    const watched = active;
    if (!watched) return;
    try {
      watched.onChange();
    } catch (error) {
      appLog.warn('[ProjectMetricsWatcher] Could not report the change:', error);
    }
    // Sessions started since the watch began, and transcripts moved by an account swap
    if (Date.now() - armedAt >= REARM_MS) {
      closeWatchers();
      void arm();
    }
  }, SETTLE_MS);
}
