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
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
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
  /**
   * Keep stdin open while the turn runs, so `send()` can add user messages that Claude reads at
   * its next step. Needs `--input-format stream-json` and `--replay-user-messages` in `args`:
   * Claude Code echoes every user message it reads (`isReplay`), which is the read receipt.
   * Stdin is closed when the turn's `result` arrives; the process then exits.
   */
  keepStdinOpen?: boolean;
  /**
   * keepStdinOpen: a user message was read. `id` is the one `send()` returned, or
   * `INITIAL_INPUT_ID` for the prompt the process started with.
   */
  onInputRead?: (id: string, text: string) => void;
}

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
    env: options.env,
    windowsHide: true,
    stdio: 'pipe',
  });

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
  const closeStdin = () => {
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
    let timer: NodeJS.Timeout | undefined;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return;
      let message: ClaudeStreamMessage;
      try {
        message = JSON.parse(trimmed) as ClaudeStreamMessage;
      } catch {
        return; // Not JSON (CLI warning)
      }
      if (message.type === 'result') {
        result = message as ClaudeResultMessage;
        results.push(result);
      }
      if (keepOpen) {
        const read = matchReplayedInput(message, initialRead);
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
        console.error('[ClaudeCode] onMessage handler failed:', error);
      }
      // The turn ended: no more messages for it (the process exits once stdin is closed)
      if (message.type === 'result') closeStdin();
    };

    const notifyRead = (id: string, text: string) => {
      try {
        options.onInputRead?.(id, text);
      } catch (error) {
        console.error('[ClaudeCode] onInputRead handler failed:', error);
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
      options.abortSignal?.removeEventListener('abort', onAbort);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      stdoutBuffer = '';
      stdinOpen = false;
      const unreadInputs = [...unread].map(([id, text]) => ({ id, text }));
      unread.clear();
      resolve({ exitCode, signal, result, results, unread: unreadInputs, stderr, aborted, timedOut });
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
