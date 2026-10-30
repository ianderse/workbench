/**
 * Claude Code CLI process
 * =======================
 *
 * Spawns `claude -p` (headless mode), feeds the prompt on stdin and reads the newline-delimited
 * JSON stream (`--output-format stream-json`) or the single JSON result (`--output-format json`).
 * Never blocks the main process: everything is async child-process I/O.
 */

import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { appLog } from '../app-logger';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import { withBoundedTestWorkers } from '../agent-backend/test-worker-env';
import { recordClaudeUsage, type UsageContext } from '../usage/usage-record';
import type { ClaudeResultMessage, ClaudeStreamMessage, ClaudeUserContentBlock } from './stream-types';

export interface ClaudeProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * Prompt to send. A string is passed as plain text on stdin; content blocks (text + images)
   * are sent as one stream-json user message, which requires `--input-format stream-json`.
   */
  input: string | ClaudeUserContentBlock[];
  /** Called for every parsed stream-json line */
  onMessage?: (message: ClaudeStreamMessage) => void;
  /** Called with stderr chunks (CLI warnings, errors before the run starts) */
  onStderr?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  /** Kill the process after this many milliseconds */
  timeoutMs?: number;
  /** Where to book the run's tokens (the project's usage ledger); unset = not recorded */
  usage?: UsageContext;
  /**
   * Keep stdin open while the turn runs, so `send()` can add user messages that Claude reads at
   * its next step. Needs `--input-format stream-json` and `--replay-user-messages` in `args`:
   * Claude Code echoes every user message it reads (`isReplay`), which is the read receipt.
   * Stdin is closed at a `result` when no background agent or shell of the main thread is still
   * running; otherwise it stays open while they run (Claude Code starts another turn when one
   * finishes), within a hard cap counted from the result: `BACKGROUND_AGENT_WAIT_MS` while a
   * background agent runs, `BACKGROUND_SHELL_WAIT_MS` while only shells do (a dev server never
   * ends). Ambient tasks (watchers) never keep it open. Claude Code itself still waits for its
   * background work after stdin closes, so closing early only means later messages wait in the
   * inbox for the next step.
   */
  keepStdinOpen?: boolean;
  /**
   * keepStdinOpen: a user message was read. `id` is the one `send()` returned, or
   * `INITIAL_INPUT_ID` for the prompt the process started with.
   */
  onInputRead?: (id: string, text: string) => void;
  /** keepStdinOpen: override the waits after a `result` (tests) */
  backgroundWaitMs?: { agent?: number; shell?: number; grace?: number };
}

/**
 * keepStdinOpen: after a `result` while a background agent of the main thread runs, stdin stays
 * open at most this long (it reports back in a new turn, which may read messages). A hard cap:
 * output and new turns don't extend it.
 */
export const BACKGROUND_AGENT_WAIT_MS = 30 * 60 * 1000;
/**
 * keepStdinOpen: the same cap while only background shells run. Claude Code can't tell a command
 * that finishes from a server that never does, so shells only get a short wait.
 */
export const BACKGROUND_SHELL_WAIT_MS = 2 * 60 * 1000;
/** keepStdinOpen: background tasks all finished after a `result` but no new turn started */
export const BACKGROUND_GRACE_CLOSE_MS = 30 * 1000;

/** A background task of the main thread that reports back in a new turn when it ends */
export interface BackgroundTask {
  /** `shell` for `local_bash` (may never end, e.g. a dev server), `agent` for everything else */
  kind: 'agent' | 'shell';
}

/**
 * Background tasks still running that Claude Code will report back on, from its system messages:
 * `background_tasks_changed` lists them all (the level, REPLACE semantics); `task_started`
 * (backgrounded) and `task_notification` / `task_updated` (finished) keep the map current between
 * those lists. Left out: ambient tasks (watchers, not activity), awaited ones (their tool call gets
 * the report, no new turn) and those a subagent launched (they report to the subagent). Their ids
 * go to `ignored`, so a `task_started` after the level doesn't add them back.
 */
export function trackBackgroundTasks(pending: Map<string, BackgroundTask>, message: ClaudeStreamMessage, ignored: Set<string> = new Set()): void {
  const raw = message as {
    type?: unknown; subtype?: unknown; tasks?: unknown; task_id?: unknown; task_type?: unknown; is_backgrounded?: unknown;
    ambient?: unknown; parent_task_id?: unknown; owned_by_subagent?: unknown; patch?: { status?: unknown; is_backgrounded?: unknown };
  };
  if (raw.type !== 'system') return;
  const kindOf = (type: unknown): BackgroundTask['kind'] => (type === 'local_bash' ? 'shell' : 'agent');
  if (raw.subtype === 'background_tasks_changed' && Array.isArray(raw.tasks)) {
    pending.clear();
    for (const task of raw.tasks as Array<{ task_id?: unknown; task_type?: unknown; ambient?: unknown; awaited?: unknown; parent_task_id?: unknown }>) {
      const id = task?.task_id;
      if (typeof id !== 'string') continue;
      if (task.ambient === true || task.awaited === true || typeof task.parent_task_id === 'string') ignored.add(id);
      else pending.set(id, { kind: kindOf(task.task_type) });
    }
    return;
  }
  if (typeof raw.task_id !== 'string') return;
  if (raw.subtype === 'task_started') {
    if (raw.is_backgrounded !== true || ignored.has(raw.task_id)) return;
    if (raw.ambient === true || raw.owned_by_subagent === true || typeof raw.parent_task_id === 'string') {
      ignored.add(raw.task_id);
      return;
    }
    pending.set(raw.task_id, { kind: kindOf(raw.task_type) });
  } else if (raw.subtype === 'task_notification') {
    pending.delete(raw.task_id);
  } else if (raw.subtype === 'task_updated') {
    const status = raw.patch?.status;
    if (typeof status === 'string' && status !== 'running' && status !== 'pending') pending.delete(raw.task_id);
  }
}

/** Whether a message ends one of the pending background tasks (Claude Code reports back on it) */
function endsBackgroundTask(pending: Map<string, BackgroundTask>, message: ClaudeStreamMessage): boolean {
  const raw = message as { type?: unknown; subtype?: unknown; task_id?: unknown; patch?: { status?: unknown } };
  if (raw.type !== 'system' || typeof raw.task_id !== 'string' || !pending.has(raw.task_id)) return false;
  if (raw.subtype === 'task_notification') return true;
  const status = raw.patch?.status;
  return raw.subtype === 'task_updated' && typeof status === 'string' && status !== 'running' && status !== 'pending';
}

/**
 * What started the turn a `result` ends: `task` for the prompt and Claude Code's own continuations
 * (a background task reported back), `message` for a turn that began with a message written with
 * `send()` or a peer session's message, which only answers it.
 */
export type TurnOrigin = 'task' | 'message';

/** Id `onInputRead` reports for the prompt a keep-open process started with */
export const INITIAL_INPUT_ID = 'initial';

/** A message written with `send()` that Claude never read before the process ended */
export interface UnreadInput {
  id: string;
  text: string;
}

interface ClaudeProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The final `result` message, when the CLI produced one */
  result?: ClaudeResultMessage;
  /**
   * Every `result` message, oldest first. A keep-open process can run a second turn: a message
   * written just before the first turn ended is read after it, and answered in a turn of its own.
   */
  results: ClaudeResultMessage[];
  /** What started the turn of each of `results` (same order) */
  resultOrigins: TurnOrigin[];
  /** keepStdinOpen: messages written with `send()` that were never read */
  unread: UnreadInput[];
  /** Last ~8KB of stderr */
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

/** Handle on a running Claude Code process */
export interface ClaudeProcessHandle {
  child: ChildProcess;
  done: Promise<ClaudeProcessResult>;
  /** Stop the run (SIGINT first so Claude Code ends the turn, then force) */
  stop: () => void;
  /**
   * keepStdinOpen: write a user message to the running turn. Returns its id (`id` when given),
   * or false when stdin is closed (the turn ended, the process exited, or not a keep-open run).
   */
  send: (text: string, id?: string) => string | false;
}

const MESSAGE_ID_PATTERN = /\[Workbench message (wbm-[A-Za-z0-9_-]+)\]/;

/** The marker block that lets a replayed message be matched to the `send()` that wrote it */
export function inputMarker(id: string): string {
  return `[Workbench message ${id}]`;
}

/** Text of a user message's content (string or blocks) */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

/**
 * Which of our inputs a replayed user message is: the id in its marker, `INITIAL_INPUT_ID` for the
 * first replay without one, or undefined for anything else (tool results, peer messages)
 */
export function matchReplayedInput(message: ClaudeStreamMessage, initialRead: boolean): string | undefined {
  const raw = message as { type?: unknown; isReplay?: unknown; isSynthetic?: unknown; origin?: unknown; message?: { content?: unknown } };
  if (raw.type !== 'user' || raw.isReplay !== true || raw.isSynthetic === true || raw.origin) return undefined;
  const content = raw.message?.content;
  if (Array.isArray(content) && content.some((block) => (block as { type?: unknown })?.type === 'tool_result')) return undefined;
  const marker = MESSAGE_ID_PATTERN.exec(contentText(content));
  if (marker) return marker[1];
  return initialRead ? undefined : INITIAL_INPUT_ID;
}

/** Spawn the Claude Code CLI and collect its output */
export function startClaudeProcess(options: ClaudeProcessOptions): ClaudeProcessHandle {
  const child = spawnTool('claude', options.args, {
    command: options.command,
    cwd: options.cwd,
    env: withBoundedTestWorkers(options.env),
    windowsHide: true,
    stdio: 'pipe',
    // The tools the agent runs (npm test -> vitest workers) end with it
    processGroup: true,
  });

  const startedMs = Date.now();
  let aborted = false;
  let timedOut = false;
  const stop = () => {
    if (child.exitCode !== null || child.killed) return;
    killRuntimeProcess(child, { debugPrefix: '[ClaudeCode]' });
  };

  // Keep-open stdin: messages written but not read yet, and whether stdin still takes messages
  const keepOpen = options.keepStdinOpen === true;
  const unread = new Map<string, string>();
  let stdinOpen = keepOpen;
  let initialRead = false;
  // Background tasks that report back in a new turn, and the timers that close stdin after a result
  // while they run: a hard cap (never extended or cleared by output or new turns) and a short grace
  // when they all ended without a new turn starting
  const backgroundTasks = new Map<string, BackgroundTask>();
  const ignoredTasks = new Set<string>();
  let capTimer: NodeJS.Timeout | undefined;
  let capAt = Infinity;
  let graceTimer: NodeJS.Timeout | undefined;
  const clearTimers = () => {
    if (capTimer) clearTimeout(capTimer);
    if (graceTimer) clearTimeout(graceTimer);
    capTimer = graceTimer = undefined;
  };
  const closeStdin = () => {
    clearTimers();
    if (!stdinOpen) return;
    stdinOpen = false;
    child.stdin?.end();
  };
  const writeUserMessage = (content: unknown) => {
    child.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  };
  const send = (text: string, id?: string): string | false => {
    if (!stdinOpen || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
    const messageId = id ?? `wbm-${randomBytes(6).toString('hex')}`;
    try {
      writeUserMessage([{ type: 'text', text }, { type: 'text', text: inputMarker(messageId) }]);
    } catch {
      return false;
    }
    unread.set(messageId, text);
    return messageId;
  };

  const done = new Promise<ClaudeProcessResult>((resolve) => {
    let stdoutBuffer = '';
    let stderr = '';
    let result: ClaudeResultMessage | undefined;
    const results: ClaudeResultMessage[] = [];
    const resultOrigins: TurnOrigin[] = [];
    // What started the current turn: decided by its first telling message (undefined until then)
    let turnOrigin: TurnOrigin | undefined;
    let afterResult = false;
    let timer: NodeJS.Timeout | undefined;

    /** Close stdin by `ms` from now at the latest: an earlier cap is never pushed back */
    const capStdin = (ms: number) => {
      const at = Date.now() + ms;
      if (at >= capAt) return;
      capAt = at;
      if (capTimer) clearTimeout(capTimer);
      capTimer = setTimeout(closeStdin, ms);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return;
      let message: ClaudeStreamMessage;
      try {
        message = JSON.parse(trimmed) as ClaudeStreamMessage;
      } catch {
        return; // Not JSON (CLI warning)
      }
      const read = keepOpen ? matchReplayedInput(message, initialRead) : undefined;
      // The turn's origin: a message of ours or a peer's that comes first starts a turn that only
      // answers it; the prompt, Claude's own reply or a background task reporting back is the task's.
      // A turn that began with a message but takes in a background report is the task's too.
      const raw = message as { type?: unknown; parent_tool_use_id?: unknown; origin?: { kind?: unknown } };
      const peer = raw.type === 'user' && raw.origin?.kind === 'peer';
      const reportBack = endsBackgroundTask(backgroundTasks, message);
      if (reportBack) turnOrigin = 'task';
      else if (turnOrigin === undefined) {
        if ((read && read !== INITIAL_INPUT_ID) || peer) turnOrigin = 'message';
        else if (read === INITIAL_INPUT_ID || (raw.type === 'assistant' && !raw.parent_tool_use_id)) turnOrigin = 'task';
      }
      if (message.type === 'result') {
        result = message as ClaudeResultMessage;
        results.push(result);
        resultOrigins.push(turnOrigin ?? 'task');
        turnOrigin = undefined;
      }
      trackBackgroundTasks(backgroundTasks, message, ignoredTasks);
      if (keepOpen) {
        if (read === INITIAL_INPUT_ID) {
          initialRead = true;
          notifyRead(read, contentText((message as { message?: { content?: unknown } }).message?.content));
        } else if (read && unread.has(read)) {
          const text = unread.get(read)!;
          unread.delete(read);
          notifyRead(read, text);
        }
      }
      try {
        options.onMessage?.(message);
      } catch (error) {
        appLog.error('[ClaudeCode] onMessage handler failed:', error);
      }
      if (!keepOpen || !stdinOpen) return;
      const waits = options.backgroundWaitMs ?? {};
      if (message.type === 'result') {
        // The turn ended. With nothing left running that reports back the CLI is done: close stdin
        // so it exits. Otherwise keep it open while they run, within the hard cap.
        afterResult = true;
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = undefined;
        if (backgroundTasks.size === 0) {
          closeStdin();
          return;
        }
        const agents = [...backgroundTasks.values()].some((task) => task.kind === 'agent');
        capStdin(agents ? waits.agent ?? BACKGROUND_AGENT_WAIT_MS : waits.shell ?? BACKGROUND_SHELL_WAIT_MS);
        return;
      }
      if (!afterResult) return;
      if ((read && read !== INITIAL_INPUT_ID) || peer || (raw.type === 'assistant' && !raw.parent_tool_use_id)) {
        // Another turn runs (a background task reported back, or a message was read): its result
        // decides again. The cap keeps running.
        afterResult = false;
        if (graceTimer) clearTimeout(graceTimer);
        graceTimer = undefined;
        return;
      }
      if (backgroundTasks.size === 0 && !graceTimer) {
        // They all ended (or were stopped) without a turn starting yet: close soon unless one does
        graceTimer = setTimeout(closeStdin, waits.grace ?? BACKGROUND_GRACE_CLOSE_MS);
      }
    };

    const notifyRead = (id: string, text: string) => {
      try {
        options.onInputRead?.(id, text);
      } catch (error) {
        appLog.error('[ClaudeCode] onInputRead handler failed:', error);
      }
    };

    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        handleLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
      options.onStderr?.(chunk);
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      clearTimers();
      options.abortSignal?.removeEventListener('abort', onAbort);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      stdoutBuffer = '';
      // Each turn's result books its own tokens (a keep-open run can answer several messages)
      if (results.length > 0) for (const turn of results) recordClaudeUsage(options.usage, turn, startedMs);
      else recordClaudeUsage(options.usage, result, startedMs);
      stdinOpen = false;
      const unreadInputs = [...unread].map(([id, text]) => ({ id, text }));
      unread.clear();
      resolve({ exitCode, signal, result, results, resultOrigins, unread: unreadInputs, stderr, aborted, timedOut });
    };
    child.on('error', (error) => {
      stderr = (stderr + `\n${error.message}`).slice(-8000);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    child.stdin?.on('error', () => {
      // Process exited before reading stdin
      stdinOpen = false;
    });
    if (keepOpen) {
      // Send the prompt and keep stdin open for messages during the turn
      writeUserMessage(typeof options.input === 'string' ? [{ type: 'text', text: options.input }] : options.input);
      return;
    }
    // Send the prompt and close stdin so the run starts
    const input = typeof options.input === 'string'
      ? options.input
      : `${JSON.stringify({ type: 'user', message: { role: 'user', content: options.input } })}\n`;
    child.stdin?.end(input);
  });

  if (options.abortSignal?.aborted) {
    aborted = true;
    stop();
  }

  return { child, done, stop, send };
}
