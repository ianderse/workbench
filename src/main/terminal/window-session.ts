/**
 * Following the session an agent window's Claude Code runs
 *
 * An agent window's header names its worktree, its Claude Code session and its task. Workbench sets
 * them when it starts the window's Claude Code or the user picks from them, but the user can also
 * turn Claude Code to another session in the window itself: `/resume`, `/clear`, or
 * `claude --resume` typed in the shell. The Live agent's hooks report every session Claude Code
 * starts and every prompt it is given, with the window it runs in (WORKBENCH_TERMINAL_ID, which
 * Claude Code inherits from the window's shell), and this brings the header in line:
 *
 * - the session is recorded as the window's own (`agent-sessions.json`): the Session menu marks it
 *   as the current one, and restoring the window resumes it rather than the one it ran before;
 * - the worktree follows the directory the session runs in, when that is one of the project's
 *   worktrees (the project's own folder leaves it as it is, see the handler). Only what the
 *   Worktree menu shows changes; the window's shell stays as it is (picking a worktree from the
 *   menu is what moves the shell);
 * - the renderer is told the session, so the Session menu's label and the Task menu follow it.
 *
 * Background sessions (`claude --bg`, and the ones Claude Code opens for itself) inherit the
 * window's environment too, while the window goes on running its own session. Claude Code's
 * registry of its processes (`<config dir>/sessions/<pid>.json`) tells them apart by their kind.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { IPC_CHANNELS } from '../../shared/constants';
import type { OtherWorktreeInfo, TerminalWorktreeConfig } from '../../shared/types';
import { getTaskWorktreeBranch } from '../../shared/utils/claude-run';
import { lastAgentSession } from '../agent-session-store';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import {
  getTaskWorktreeDir,
  getTerminalWorktreeDir,
  getTerminalWorktreeMetadataPath,
} from '../worktree-paths';
import type { TerminalProcess } from './types';

/** The session an agent window's Claude Code runs now, as its hooks report it */
export interface WindowSessionReport {
  terminalId: string;
  sessionId: string;
  /** Claude Code's working directory when the hook ran (a host path) */
  cwd?: string;
  /** The hook that reported it: the session starting, or a prompt given in it */
  event?: 'SessionStart' | 'UserPromptSubmit';
  /** How the session started (`startup`, `resume`, `clear`, `compact`), on SessionStart */
  source?: string;
}

export interface WindowSessionDeps {
  getTerminal: (terminalId: string) => TerminalProcess | undefined;
  /** Set the window's worktree and persist the window (TerminalManager.setWorktreeConfig) */
  setWorktreeConfig: (terminalId: string, config: TerminalWorktreeConfig | undefined) => void;
  /** Send an event to the renderers */
  send: (channel: string, ...args: unknown[]) => void;
  /** Record a session as the window's own (cli-integration-handler's recordWindowSession) */
  recordSession: (terminal: TerminalProcess, sessionId: string, cwd: string) => Promise<void>;
  /** The project's worktrees Workbench didn't make (`git worktree list`) */
  listOtherWorktrees: (projectPath: string) => Promise<OtherWorktreeInfo[]>;
  /** Claude Code config dirs, each with its process registry under `sessions/` */
  claudeConfigDirs: () => string[];
  /** Wait between looks at the registry (tests wait for nothing) */
  wait?: (ms: number) => Promise<void>;
}

/** Sessions found to be background sessions, remembered so their every hook isn't looked up again */
const MAX_IGNORED_SESSIONS = 200;

/** How often, and how far apart, the registry is looked at for a session that has to be listed
 *  there: a new process writes its entry as it starts, a moment after its first hook can fire */
const REGISTRY_ATTEMPTS = 3;
const REGISTRY_WAIT_MS = 500;

/** What Claude Code's process registry says about a session */
type RegistryKind = 'interactive' | 'other' | 'unlisted';

/**
 * How a session runs, from Claude Code's registry of its processes: in a terminal (`interactive`),
 * some other way (in the background), or not listed. A process that ran the session in a terminal
 * settles it, whatever stale entries other processes left.
 */
async function sessionRegistryKind(sessionId: string, configDirs: string[]): Promise<RegistryKind> {
  let kind: RegistryKind = 'unlisted';
  for (const configDir of configDirs) {
    const dir = path.join(configDir, 'sessions');
    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }
    const entries = await Promise.all(
      files.map(async (file) => {
        try {
          return JSON.parse(await fsp.readFile(path.join(dir, file), 'utf-8')) as { sessionId?: unknown; kind?: unknown };
        } catch {
          return null;
        }
      })
    );
    for (const entry of entries) {
      if (!entry || entry.sessionId !== sessionId) continue;
      if (entry.kind === 'interactive') return 'interactive';
      kind = 'other';
    }
  }
  return kind;
}

/** A path as compared with another (case-folded on Windows, where drive letters disagree) */
function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return isWindows() ? resolved.toLowerCase() : resolved;
}

/** The path of `child` below `parent` (`''` for the same path), or null when it isn't inside it */
function relativeInside(child: string, parent: string): string | null {
  const relative = path.relative(pathKey(parent), pathKey(child));
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

/** The first directory of a relative path */
const firstSegment = (relative: string) => relative.split(/[\\/]/)[0];

/** A terminal worktree's stored config, where the worktree menu lists it from */
async function readTerminalWorktreeConfig(projectPath: string, name: string): Promise<TerminalWorktreeConfig | null> {
  const files = [
    getTerminalWorktreeMetadataPath(projectPath, name),
    // Where older versions kept it, inside the worktree
    path.join(getTerminalWorktreeDir(projectPath), name, 'config.json'),
  ];
  for (const file of files) {
    try {
      const config = JSON.parse(await fsp.readFile(file, 'utf-8')) as TerminalWorktreeConfig;
      if (config && typeof config.worktreePath === 'string') return config;
    } catch {
      // Not there (or unreadable): the next place, then a config of its own
    }
  }
  return null;
}

/**
 * The worktree an agent window shows for a session run in `cwd`, built as the worktree menu builds
 * it when the worktree is picked there: a worktree of the project (a task's, a window's, or one
 * Workbench didn't make), undefined in the project itself, or null when `cwd` says nothing about
 * it (outside the project, or in Workbench's own folders)
 */
async function worktreeForCwd(
  projectPath: string,
  cwd: string,
  terminalId: string,
  listOtherWorktrees: (projectPath: string) => Promise<OtherWorktreeInfo[]>
): Promise<TerminalWorktreeConfig | undefined | null> {
  if (relativeInside(cwd, projectPath) === '') return undefined;
  const createdAt = new Date().toISOString();

  const tasksDir = getTaskWorktreeDir(projectPath);
  const inTasks = relativeInside(cwd, tasksDir);
  if (inTasks) {
    const specId = firstSegment(inTasks);
    return {
      name: specId,
      worktreePath: path.join(tasksDir, specId),
      branchName: getTaskWorktreeBranch(specId),
      baseBranch: '',
      hasGitBranch: true,
      createdAt,
      terminalId,
    };
  }

  const terminalsDir = getTerminalWorktreeDir(projectPath);
  const inTerminals = relativeInside(cwd, terminalsDir);
  if (inTerminals) {
    const name = firstSegment(inTerminals);
    return (await readTerminalWorktreeConfig(projectPath, name)) ?? {
      name,
      worktreePath: path.join(terminalsDir, name),
      branchName: '',
      baseBranch: '',
      hasGitBranch: false,
      createdAt,
      terminalId,
    };
  }

  // Inside the project but not in Workbench's worktrees: a worktree of its own there (Claude Code's
  // `--worktree` makes them under .claude/worktrees), else a folder of the project itself
  const other = (await listOtherWorktrees(projectPath))
    .filter((worktree) => relativeInside(cwd, worktree.path) !== null)
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (other) {
    return {
      name: other.displayName,
      worktreePath: other.path,
      branchName: other.branch ?? '',
      baseBranch: '',
      hasGitBranch: other.branch !== null,
      createdAt,
      terminalId,
    };
  }
  const inProject = relativeInside(cwd, projectPath);
  if (inProject === null) return null;
  // Workbench's own folders (.workbench/worktrees/pr, ...) aren't the project's code
  return firstSegment(inProject) === '.workbench' ? null : undefined;
}

/**
 * Follow the sessions agent windows' Claude Code turns to (see the top of this file). Returns the
 * handler for the hooks' reports; each window's reports are handled one after another, and a
 * report repeating the window's last one (every prompt of the session sends one) does nothing.
 */
export function createWindowSessionTracker(deps: WindowSessionDeps): (report: WindowSessionReport) => Promise<void> {
  /** Each window's last report handled, as `<session id>\0<cwd>` */
  const lastReport = new Map<string, string>();
  const queues = new Map<string, Promise<void>>();
  const ignored = new Set<string>();

  const ignore = (sessionId: string) => {
    ignored.add(sessionId);
    if (ignored.size > MAX_IGNORED_SESSIONS) ignored.delete(ignored.values().next().value!);
  };

  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const handle = async (report: WindowSessionReport): Promise<void> => {
    const { terminalId, sessionId } = report;
    const started = report.event === 'SessionStart';
    // The window's Claude Code turning to a session in place (`/resume`, `/clear`, compaction) says
    // so as it starts it: that is trusted unless the registry has the session as another
    // process's. A session a new process starts (`startup`), or one only a prompt reports, may as
    // well be a `claude -p` the agent ran in the window, which inherits the window's id too and
    // never runs in a terminal: only one the registry lists as a terminal's own is taken then
    const inPlace = started && report.source !== undefined && report.source !== 'startup';
    let kind = await sessionRegistryKind(sessionId, deps.claudeConfigDirs());
    for (let attempt = 1; !inPlace && kind === 'unlisted' && attempt < REGISTRY_ATTEMPTS; attempt++) {
      await wait(REGISTRY_WAIT_MS);
      kind = await sessionRegistryKind(sessionId, deps.claudeConfigDirs());
    }
    if (kind === 'other') {
      ignore(sessionId);
      return;
    }
    if (!inPlace && kind !== 'interactive') return;
    // Where the session runs is where it started. A prompt's directory is wherever the agent last
    // moved its shell to (`cd` in its Bash tool), which says nothing about the session
    const cwd = started ? report.cwd : undefined;
    const terminal = deps.getTerminal(terminalId);
    if (!terminal?.projectPath) return;
    const projectPath = terminal.projectPath;

    const own = await lastAgentSession(projectPath, terminalId);
    if (own?.sessionId !== sessionId) await deps.recordSession(terminal, sessionId, cwd || terminal.cwd);

    if (cwd) {
      const worktree = await worktreeForCwd(projectPath, cwd, terminalId, deps.listOtherWorktrees);
      // Only a worktree the session is found running in changes what the menu shows. The project
      // itself says nothing: a restored window resumes its session from the project's folder,
      // whatever worktree it was in (resumeClaudeAsync), so taking the worktree off on that would
      // take it off every restored worktree window. (The window may also have closed, or been
      // recreated under the same id, meanwhile.)
      if (worktree && deps.getTerminal(terminalId) === terminal) {
        const current = terminal.worktreeConfig;
        const unchanged = current !== undefined && pathKey(current.worktreePath) === pathKey(worktree.worktreePath);
        if (!unchanged) {
          deps.setWorktreeConfig(terminalId, worktree);
          deps.send(IPC_CHANNELS.TERMINAL_WORKTREE_CONFIG_CHANGE, terminalId, worktree);
        }
      }
    }

    deps.send(IPC_CHANNELS.TERMINAL_CLAUDE_SESSION_CHANGE, terminalId, sessionId);
  };

  return (report) => {
    if (!report.terminalId || !report.sessionId || ignored.has(report.sessionId)) return Promise.resolve();
    // A prompt's directory counts for nothing (see above), so only a start's tells two reports apart
    const key = `${report.sessionId}\0${report.event === 'SessionStart' ? report.cwd ?? '' : ''}`;
    if (lastReport.get(report.terminalId) === key) return Promise.resolve();
    lastReport.set(report.terminalId, key);

    const next = (queues.get(report.terminalId) ?? Promise.resolve()).then(() => handle(report)).catch((error) => {
      // Handled again when the next hook reports it
      if (lastReport.get(report.terminalId) === key) lastReport.delete(report.terminalId);
      appLog.warn(`[WindowSession] Could not follow the session of window ${report.terminalId}:`, error);
    });
    queues.set(report.terminalId, next);
    void next.then(() => {
      if (queues.get(report.terminalId) === next) queues.delete(report.terminalId);
    });
    return next;
  };
}
