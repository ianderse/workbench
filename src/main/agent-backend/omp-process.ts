/**
 * OMP process
 * ===========
 *
 * Spawns `omp -p --mode json` (oh-my-pi) and hands back the same `ClaudeProcessHandle` the Claude
 * Code runner returns: the JSON event stream is translated into Claude stream messages
 * (omp-translate.ts), so callers keep their message handling. The prompt goes in on stdin
 * (`omp -p` prepends piped input to the message); images and PDFs become temp files passed as
 * `@path`. Long system prompts also go through temp files. Everything is removed when the run ends.
 *
 * Live messages: with `options.live` the step runs through `omp --mode rpc` instead (omp-rpc.ts documents the
 * protocol): the same events, so the same translator, plus a stdin that stays open for `steer` commands.
 * If the RPC process does not start a run, the step is repeated with `-p`.
 *
 * A caller's JSON schema is put into the prompt (OMP has no `--json-schema`); when the final
 * answer has no parseable object the run is repeated once, asking for the JSON alone.
 */

import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { appLog } from '../app-logger';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import type { ClaudeProcessHandle } from '../claude-code/process';
import type { ClaudeResultMessage, ClaudeStreamMessage, ClaudeUserContentBlock } from '../claude-code/stream-types';
import type { ClaudeEffort } from '../../shared/types/claude-code';
import { ompSubagentsPerTask, type OmpBackendSettings } from '../../shared/types/agent-backend';
import { buildOmpAdvisorOverlay, buildOmpArgs, OMP_FOREGROUND_OVERLAY, OMP_FOREGROUND_RULE, resolveOmpAdvisor, resolveOmpSelection, type OmpRole } from './omp-args';
import { resolveOmpCommand } from './omp-command';
import { startWithOmpCooldownRecovery } from './omp-provider-recovery';
import type { OmpFallbackChains } from './omp-roles';
import { getOmpRoles } from './omp-roles';
import { buildOmpUtilityExtension } from './omp-utility';
import { buildJsonRepairPrompt, buildStructuredInstruction, parseStructuredOutput } from './omp-structured';
import { createOmpTranslator, isOmpNotice } from './omp-translate';
import { hasPendingAsyncWork, isSessionSettled, isWorkingEvent, parseRpcLine, readSteerId, rpcGetState, rpcPrompt, rpcSteer, RPC_PENDING_ID, RPC_PROMPT_ID, RPC_STATE_ID, sessionIdOf, steerText } from './omp-rpc';
import { recordOmpUsage, type UsageContext } from '../usage/usage-record';

type OmpProcessOutcome = Awaited<ClaudeProcessHandle['done']>;

export { resolveOmpCommand };

export interface OmpRunOptions {
  settings: OmpBackendSettings;
  /** Host-filtered native fallback chains while providers are cooling down. */
  cooldownFallbackChains?: OmpFallbackChains;
  cwd: string;
  /** Extra environment on top of the app's own */
  env?: Record<string, string>;
  prompt: string | ClaudeUserContentBlock[];
  /** Workbench model tier or Claude model id (mapped through the settings) */
  model?: string;
  /** OMP role used when the model has no explicit OMP model; default `default` */
  role?: OmpRole;
  /** Let OMP switch to its fallback models if the model fails (only the final attempt of a task phase) */
  allowFallback?: boolean;
  effort?: ClaudeEffort;
  /** OMP tool names, or 'all' */
  tools: 'all' | readonly string[];
  autoApprove?: boolean;
  /** Replaces OMP's system prompt */
  systemPrompt?: string;
  /** Appended to OMP's system prompt */
  appendSystemPrompt?: string;
  /** Persist the session in `dir`; `resume` continues the session with that id. Unset = no session */
  session?: { dir: string; resume?: string };
  /** JSON Schema the final answer must match (put into the prompt, parsed from the answer) */
  jsonSchema?: Record<string, unknown>;
  maxTimeMinutes?: number;
  /** Utility call: no extensions or skills */
  oneShot?: boolean;
  /** Emit `omp_text_delta` messages while text streams */
  emitDeltas?: boolean;
  /** Emit `omp_progress` messages (chunk sizes) while a reply streams */
  emitProgress?: boolean;
  onMessage?: (message: ClaudeStreamMessage) => void;
  onStderr?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /** Extension files to load for the run (`-e`), e.g. Workbench's task messaging tools */
  extensions?: readonly string[];
  /** Where to book the run's tokens (the project's usage ledger); unset = not recorded */
  usage?: UsageContext;
  /**
   * Live messages: run through `omp --mode rpc` (unless the setting is off, attachments are given or the call is a
   * utility call) so `send()` can steer the running step. `onInputRead` gets the id `send()` returned and the text
   * once the model has read the message; the ones never read come back in `done`'s `unread`
   */
  live?: { onInputRead?: (id: string, text: string) => void };
  /** Tests: override the RPC start-up waits (ms) */
  rpcWaitsMs?: { ready?: number; start?: number; settle?: number; state?: number; hang?: number; poll?: number };
  /** Names the run in log lines (spec id and phase); default: the working directory's name */
  label?: string;
}

function extensionFor(mediaType: string): string {
  if (mediaType === 'application/pdf') return '.pdf';
  const sub = mediaType.split('/')[1]?.split('+')[0];
  return sub ? `.${sub.replace(/[^a-z0-9]/gi, '')}` : '';
}

/** Split Claude-style content blocks into prompt text and attachment blocks */
function splitPrompt(prompt: string | ClaudeUserContentBlock[]): { text: string; files: Array<{ mediaType: string; data: string }> } {
  if (typeof prompt === 'string') return { text: prompt, files: [] };
  const texts: string[] = [];
  const files: Array<{ mediaType: string; data: string }> = [];
  for (const block of prompt) {
    if (block.type === 'text') {
      texts.push(block.text);
    } else if (block.type === 'image' || block.type === 'document') {
      const source = (block as { source?: { media_type?: string; data?: string } }).source;
      if (source?.data) files.push({ mediaType: source.media_type ?? 'application/octet-stream', data: source.data });
    }
  }
  return { text: texts.join('\n\n'), files };
}

/**
 * Start an OMP run. Resolves once the process is spawned; `handle.done` resolves when the run
 * (including a JSON repair run, if one was needed) is over.
 */
export async function startOmpProcess(options: OmpRunOptions): Promise<ClaudeProcessHandle> {
  return startWithOmpCooldownRecovery(options, startOmpProcessOnce);
}

async function startOmpProcessOnce(options: OmpRunOptions): Promise<ClaudeProcessHandle> {
  const command = await resolveOmpCommand(options.settings.command, options.env?.PATH ?? process.env.PATH);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'workbench-omp-'));
  const cleanup = () => rm(tempDir, { recursive: true, force: true }).catch(() => undefined);

  let setup: {
    text: string;
    attachmentPaths: string[];
    systemPromptFile?: string;
    appendSystemPromptFile?: string;
    advisorOverlayFile?: string;
    foregroundOverlayFile?: string;
    extensionPaths: string[];
    repairExtensionPath?: string;
  };
  // One-shot utility calls never use the advisor; the setting applies to the other runs
  const advisor = resolveOmpAdvisor(options.settings, options.oneShot);
  // Roles are read in the background; until they are known `--model` is left out
  const roles = getOmpRoles();
  const role = options.role ?? 'default';
  const selection = resolveOmpSelection(options.model, options.settings, role, roles);
  const isolatedUtility = options.oneShot === true && options.tools !== 'all' && options.tools.length === 0 && !options.extensions?.length;
  try {
    if (options.session) await mkdir(options.session.dir, { recursive: true });
    const { text, files } = splitPrompt(options.prompt);
    const attachmentPaths: string[] = [];
    for (const [index, file] of files.entries()) {
      const target = path.join(tempDir, `attachment-${index + 1}${extensionFor(file.mediaType)}`);
      await writeFile(target, Buffer.from(file.data, 'base64'));
      attachmentPaths.push(target);
    }
    let systemPromptFile: string | undefined;
    if (options.systemPrompt) {
      systemPromptFile = path.join(tempDir, 'system-prompt.md');
      await writeFile(systemPromptFile, options.systemPrompt, 'utf-8');
    }
    let appendSystemPromptFile: string | undefined;
    // Runs with the bash tool get the foreground rule (a background job's result may never arrive)
    const usesBash = options.tools === 'all' || options.tools.includes('bash');
    const appendText = [options.appendSystemPrompt, usesBash ? OMP_FOREGROUND_RULE : undefined].filter(Boolean).join('\n\n');
    if (appendText) {
      appendSystemPromptFile = path.join(tempDir, 'append-system-prompt.md');
      await writeFile(appendSystemPromptFile, appendText, 'utf-8');
    }
    // Print mode ends the process with the agent, so bash must not run jobs in the background there
    let foregroundOverlayFile: string | undefined;
    if (usesBash) {
      foregroundOverlayFile = path.join(tempDir, 'foreground-overlay.yml');
      await writeFile(foregroundOverlayFile, OMP_FOREGROUND_OVERLAY, 'utf-8');
    }
    let advisorOverlayFile: string | undefined;
    const advisorOverlay = buildOmpAdvisorOverlay(advisor, options.allowFallback === true, ompSubagentsPerTask(options.settings), options.cooldownFallbackChains);
    if (advisorOverlay) {
      advisorOverlayFile = path.join(tempDir, 'advisor-overlay.yml');
      await writeFile(advisorOverlayFile, advisorOverlay, 'utf-8');
    }
    const extensionPaths = [...(options.extensions ?? [])];
    let repairExtensionPath: string | undefined;
    if (options.oneShot) {
      repairExtensionPath = path.join(tempDir, 'json-repair-utility.mjs');
      await writeFile(repairExtensionPath, buildOmpUtilityExtension('Format the supplied answer as the requested JSON. Preserve its information, do not add facts, and do not use tools.'), 'utf8');
    }
    if (isolatedUtility) {
      const utilityFile = path.join(tempDir, 'text-utility.mjs');
      await writeFile(utilityFile, buildOmpUtilityExtension(options.systemPrompt, options.appendSystemPrompt), 'utf8');
      extensionPaths.push(utilityFile);
    }
    setup = {
      extensionPaths,
      repairExtensionPath,
      advisorOverlayFile,
      foregroundOverlayFile,
      text: options.jsonSchema ? `${text}\n\n${buildStructuredInstruction(options.jsonSchema)}` : text,
      attachmentPaths,
      systemPromptFile,
      appendSystemPromptFile,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...(options.env ?? {}) })) {
    if (typeof value === 'string') env[key] = value;
  }
  env.NO_COLOR = '1';

  let aborted = false;
  let timedOut = false;
  let current: ChildProcess | undefined;
  const stop = () => {
    if (!current || current.exitCode !== null || current.killed) return;
    killRuntimeProcess(current, { debugPrefix: '[OMP]' });
  };

  /** Live messages: written to a running RPC process; `unread` keeps what the model has not read yet */
  const live = {
    child: undefined as ChildProcess | undefined,
    /** Accepting messages: from the spawn of an RPC process until its run ended */
    open: false,
    /** The run started: messages are written at once; before that they wait in `pending` */
    started: false,
    pending: [] as Array<{ id: string; text: string }>,
    unread: new Map<string, string>(),
  };
  const send = (text: string, id?: string): string | false => {
    const target = live.child;
    if (!live.open || !target || target.exitCode !== null || target.killed || !target.stdin || target.stdin.destroyed || target.stdin.writableEnded) return false;
    const messageId = id ?? `wbm-${randomBytes(6).toString('hex')}`;
    if (live.started) {
      try {
        target.stdin.write(rpcSteer(messageId, steerText(text, messageId)));
      } catch {
        return false;
      }
    } else {
      // The run is still starting: the message goes in as soon as it began
      live.pending.push({ id: messageId, text });
    }
    live.unread.set(messageId, text);
    return messageId;
  };
  const label = options.label ?? path.basename(options.cwd);
  const waits = { ready: 20_000, start: 30_000, settle: 8_000, state: 5_000, hang: 10 * 60_000, poll: 30_000, ...(options.rpcWaitsMs ?? {}) };

  interface RunOnceResult {
    outcome: Omit<OmpProcessOutcome, 'result'>;
    result?: ClaudeResultMessage;
    text: string;
    sessionId?: string;
    /** RPC only: the run never started, this is why (the caller repeats the step in print mode) */
    fallback?: string;
  }

  /**
   * One `omp` process. Print mode: the prompt goes in on stdin, which is closed. RPC mode (`rpc`): the prompt
   * is a `prompt` command and stdin stays open for `steer` commands until the session settled. An RPC process
   * that never gets a run going resolves with `fallback` so the caller can run the step in print mode.
   */
  const runOnce = (args: string[], input: string, holdResult: boolean, resumeNote?: string, rpc = false) => {
    // `spawnTool` names only the tools cli-tool-manager knows; `command` is what runs
    // (inside WSL it must be an absolute Linux path)
    const child = spawnTool('claude', args, { command, cwd: options.cwd, env, windowsHide: true, stdio: 'pipe', processGroup: true });
    current = child;
    if (resumeNote) appLog.info(`[OMP] ${resumeNote}`);
    return new Promise<RunOnceResult>((resolve) => {
      const translator = createOmpTranslator({ model: selection.concrete ?? selection.selector, emitDeltas: options.emitDeltas, emitProgress: options.emitProgress });
      let buffer = '';
      let stderr = '';
      let held: ClaudeResultMessage | undefined;
      // RPC state
      let started = false; // agent_start seen: the prompt is running, no fallback any more
      // The prompt was accepted (successful response) or omp showed it is working on it (compaction, queue, agent
      // events). OMP may compact the session before agent_start, which takes minutes on a local model: from here a
      // slow start is not a failed start, only a silent process (`waits.hang`) is given up
      let accepted = false;
      let promptSent = false;
      let ended = false; // agent_end seen
      let fallback: string | undefined;
      let stdinClosed = false;
      let settleTimer: NodeJS.Timeout | undefined;
      let resultForwarded = false;
      // RPC: a finished background job starts a second run in the same process; its result is the one that counts,
      // so the result is passed on when the process ends
      const holdHere = holdResult || rpc;
      const timers = new Set<NodeJS.Timeout>();
      const after = (ms: number, fn: () => void) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, ms);
        timers.add(timer);
        return timer;
      };
      const clearTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
      const giveUp = (reason: string) => {
        if (fallback || started || accepted) return;
        fallback = reason;
        stop();
      };
      const closeStdin = () => {
        if (stdinClosed) return;
        stdinClosed = true;
        live.open = false;
        try {
          child.stdin?.end();
        } catch {
          // Already closed
        }
      };
      const forward = (message: ClaudeStreamMessage) => {
        try {
          options.onMessage?.(message);
        } catch (error) {
          appLog.error('[OMP] onMessage handler failed', error);
        }
      };
      const emit = (event: unknown) => {
        for (const message of translator.translate(event)) {
          if (isOmpNotice(message)) {
            if (options.oneShot) appLog.warn(`[OMP] Notice (${message.source}): ${message.text}`);
          }
          if (message.type === 'result') {
            held = message as ClaudeResultMessage;
            if (!holdHere) {
              resultForwarded = true;
              forward(message);
            }
          } else {
            forward(message);
          }
        }
      };
      const sendPrompt = () => {
        if (promptSent || stdinClosed) return;
        promptSent = true;
        child.stdin?.write(rpcPrompt(input));
        after(waits.start, () => giveUp('no response to the prompt'));
      };
      // Hang guard before agent_start: restarted by every stdout line, so a compaction that talks never trips it
      let hangTimer: NodeJS.Timeout | undefined;
      const armHangGuard = () => {
        if (hangTimer) clearTimeout(hangTimer);
        hangTimer = setTimeout(() => {
          stderr = (stderr + `\nWorkbench: no output from omp for ${Math.round(waits.hang / 1000)} s before the run started`).slice(-8000);
          appLog.warn(`[OMP] ${label}: no output from omp for ${Math.round(waits.hang / 1000)} s after the prompt was accepted, stopping it`);
          stop();
        }, waits.hang);
      };
      const disarmHangGuard = () => {
        if (hangTimer) clearTimeout(hangTimer);
        hangTimer = undefined;
      };
      const markAccepted = () => {
        if (accepted) return;
        accepted = true;
        clearTimers();
      };
      /**
       * After an agent_end: omp keeps a background job's result for a follow-up run (`hasPendingAsyncWork` in
       * `get_state`, see omp-rpc.ts), so the process stays open while one is pending and is checked again every
       * `waits.poll`. The step's own timeout and the job's deadline (omp kills it) bound the wait.
       */
      const askPending = () => {
        if (!ended || stdinClosed) return;
        try {
          child.stdin?.write(rpcGetState(RPC_PENDING_ID));
        } catch {
          // Closed: the process is ending
        }
      };
      let pendingNoted = false;
      const onPendingState = (pending: boolean) => {
        if (!ended || stdinClosed) return;
        if (pending) {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = undefined;
          // Messages may still be steered into the session while it waits for the job
          live.open = true;
          if (!pendingNoted) {
            pendingNoted = true;
            appLog.info(`[OMP] ${label}: waiting for a background job to finish before closing omp`);
          }
          after(waits.poll, askPending);
        } else {
          live.open = false;
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = after(waits.settle, closeStdin);
        }
      };
      const handleRpcLine = (line: string) => {
        const parsed = parseRpcLine(line);
        if (!parsed) return;
        if (accepted && !started) armHangGuard();
        if (parsed.kind === 'invalid') {
          if (!started) giveUp('unparseable output before the run started');
          return;
        }
        if (parsed.kind === 'ready') {
          clearTimers();
          child.stdin?.write(rpcGetState());
          // The session id comes from get_state; without an answer the prompt goes out anyway
          after(waits.state, sendPrompt);
          return;
        }
        if (parsed.kind === 'response') {
          if (parsed.id === RPC_STATE_ID) {
            const sessionId = parsed.success ? sessionIdOf(parsed.data) : undefined;
            if (sessionId) emit({ type: 'session', id: sessionId, cwd: options.cwd });
            sendPrompt();
          } else if (parsed.id === RPC_PENDING_ID) {
            onPendingState(parsed.success ? hasPendingAsyncWork(parsed.data) : false);
          } else if (parsed.id === RPC_PROMPT_ID && !parsed.success) {
            giveUp(`prompt refused: ${parsed.error ?? 'unknown error'}`);
          } else if (parsed.id === RPC_PROMPT_ID) {
            markAccepted();
            armHangGuard();
          }
          return;
        }
        const event = parsed.event;
        if (promptSent && !started && isWorkingEvent(event)) {
          markAccepted();
          armHangGuard();
        }
        if (event.type === 'agent_start' && ended) {
          // The follow-up run of a finished background job
          ended = false;
          pendingNoted = false;
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = undefined;
          live.open = true;
        }
        if (event.type === 'agent_start') {
          started = true;
          disarmHangGuard();
          clearTimers();
          live.started = true;
          for (const message of live.pending.splice(0)) {
            try {
              child.stdin?.write(rpcSteer(message.id, steerText(message.text, message.id)));
            } catch {
              // Stays unread: back to the inbox when the process ends
            }
          }
        }
        const steerId = readSteerId(event);
        if (steerId && live.unread.has(steerId)) {
          const text = live.unread.get(steerId)!;
          live.unread.delete(steerId);
          try {
            options.live?.onInputRead?.(steerId, text);
          } catch (error) {
            appLog.error('[OMP] onInputRead handler failed', error);
          }
        }
        emit(event);
        if (event.type === 'agent_end') {
          // Nothing more can be injected into this run
          ended = true;
          live.open = false;
          // Pending background work keeps the process open; the answer to get_state decides. No answer: close as before
          askPending();
          settleTimer = after(waits.state + waits.settle, closeStdin);
        }
        if (ended && isSessionSettled(event)) closeStdin();
      };
      const handleLine = (line: string) => {
        if (rpc) {
          handleRpcLine(line);
          return;
        }
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') return;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }
        emit(event);
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-8000);
        options.onStderr?.(chunk);
      });

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        clearTimers();
        disarmHangGuard();
        live.open = false;
        live.started = false;
        live.pending = [];
        if (buffer.trim()) handleLine(buffer);
        buffer = '';
        // An RPC process that never started a run: the caller repeats the step in print mode
        // (messages taken meanwhile stay in `unread` and go back to the inbox with the print run's outcome)
        if (rpc && !started && !accepted && !aborted && !timedOut) {
          const last = stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200);
          resolve({
            outcome: { exitCode, signal, stderr, aborted, timedOut, results: [], resultOrigins: [], unread: [] },
            text: '',
            fallback: fallback ?? `omp exited with code ${exitCode} before the run started${last ? `: ${last}` : ''}`,
          });
          return;
        }
        let result = held;
        if (!result) {
          result = translator.finalize({ exitCode, stderr, aborted, timedOut });
          if (result && !holdResult) forward(result);
        } else if (!holdResult && !resultForwarded) {
          forward(result);
        }
        // Every process books its own tokens (a JSON repair run is a second one), also when it failed
        recordOmpUsage(options.usage, translator.usage, { sessionId: translator.sessionId });
        const unread = [...live.unread].map(([id, text]) => ({ id, text }));
        live.unread.clear();
        resolve({ outcome: { exitCode, signal, stderr, aborted, timedOut, results: [], resultOrigins: [], unread }, result, text: translator.lastText, sessionId: translator.sessionId });
      };
      child.on('error', (error) => {
        stderr = (stderr + `\n${error.message}`).slice(-8000);
        finish(null, null);
      });
      child.on('close', (code, signal) => finish(code, signal));

      child.stdin?.on('error', () => { /* process exited before reading stdin */ });
      if (rpc) {
        live.child = child;
        live.open = true;
        after(waits.ready, () => giveUp('no ready message from omp'));
      } else {
        child.stdin?.end(input);
      }
    });
  };

  const baseArgs = buildOmpArgs({
    settings: options.settings,
    model: options.model,
    role,
    roles,
    effort: options.effort,
    tools: options.tools,
    autoApprove: options.autoApprove,
    systemPromptFile: setup.systemPromptFile,
    appendSystemPromptFile: setup.appendSystemPromptFile,
    session: options.session,
    maxTimeMinutes: options.maxTimeMinutes,
    oneShot: options.oneShot,
    isolatedUtility,
    advisorMode: advisor.mode,
    advisorOverlayFile: setup.advisorOverlayFile,
    foregroundOverlayFile: setup.foregroundOverlayFile,
    attachmentPaths: setup.attachmentPaths,
    extensionPaths: setup.extensionPaths,
  });
  // Live messages: an RPC process takes steer commands while the step runs. Attachments (`@file`) are not
  // supported in RPC mode, so those steps stay on print mode, as do utility calls and the setting turned off
  const useRpc = !!options.live && !options.oneShot && options.settings.liveMessages !== false && setup.attachmentPaths.length === 0;
  const rpcArgs = useRpc
    ? buildOmpArgs({
      settings: options.settings,
      model: options.model,
      role,
      roles,
      effort: options.effort,
      tools: options.tools,
      autoApprove: options.autoApprove,
      systemPromptFile: setup.systemPromptFile,
      appendSystemPromptFile: setup.appendSystemPromptFile,
      session: options.session,
      maxTimeMinutes: options.maxTimeMinutes,
      oneShot: options.oneShot,
      advisorMode: advisor.mode,
      advisorOverlayFile: setup.advisorOverlayFile,
      foregroundOverlayFile: setup.foregroundOverlayFile,
      extensionPaths: options.extensions,
      transport: 'rpc',
    })
    : undefined;

  const onAbort = () => {
    aborted = true;
    stop();
  };
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = options.timeoutMs
    ? setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs)
    : undefined;

  const startFirst = async (): Promise<RunOnceResult> => {
    if (!rpcArgs) return runOnce(baseArgs, setup.text, !!options.jsonSchema);
    const rpcRun = await runOnce(rpcArgs, setup.text, !!options.jsonSchema, undefined, true);
    if (!rpcRun.fallback) return rpcRun;
    // Never lose a step to the new transport: run it again in print mode (the RPC process did not start the run)
    appLog.warn(`[OMP] ${label}: RPC mode did not start (${rpcRun.fallback}); running this step with omp -p, messages wait for the next step`);
    if (aborted || timedOut) return rpcRun;
    return runOnce(baseArgs, setup.text, !!options.jsonSchema, 'Falling back to omp -p for this step');
  };
  const first = startFirst();
  if (options.abortSignal?.aborted) onAbort();

  const done = (async (): Promise<OmpProcessOutcome> => {
    try {
      const run = await first;
      let result = run.result;
      let outcome = run.outcome;
      const schema = options.jsonSchema;

      if (schema && result) {
        const ok = !result.is_error && !aborted && !timedOut;
        let structured = ok ? parseStructuredOutput(run.text, schema) : undefined;
        if (ok && !structured) {
          // One more try, asking for the JSON alone: in the same session when there is one
          const sessionId = result.session_id || run.sessionId;
          const resumeSession = options.session && sessionId
            ? { dir: options.session.dir, resume: sessionId }
            : undefined;
          const repairArgs = buildOmpArgs({
            settings: options.settings,
            model: options.model,
            role,
            roles,
            effort: options.effort,
            tools: [],
            session: resumeSession,
            maxTimeMinutes: options.maxTimeMinutes,
            oneShot: options.oneShot,
            isolatedUtility: options.oneShot === true && !resumeSession,
            extensionPaths: options.oneShot && !resumeSession && setup.repairExtensionPath ? [setup.repairExtensionPath] : undefined,
            advisorMode: advisor.mode,
            advisorOverlayFile: setup.advisorOverlayFile,
          });
          const repair = await runOnce(
            repairArgs,
            buildJsonRepairPrompt(schema, resumeSession ? undefined : run.text),
            true,
            'The answer had no valid JSON, asking once more for the JSON alone',
          );
          outcome = { ...repair.outcome, unread: outcome.unread };
          if (repair.result && !repair.result.is_error) {
            structured = parseStructuredOutput(repair.text, schema);
            result = {
              ...result,
              session_id: repair.result.session_id || result.session_id,
              result: structured ? repair.text || result.result : result.result,
              total_cost_usd: (result.total_cost_usd ?? 0) + (repair.result.total_cost_usd ?? 0),
              num_turns: (result.num_turns ?? 0) + (repair.result.num_turns ?? 0),
              duration_ms: (result.duration_ms ?? 0) + (repair.result.duration_ms ?? 0),
            };
          }
          if (!structured) appLog.warn('[OMP] The answer still had no valid JSON; the caller falls back to the plain text');
        }
        if (structured) result = { ...result, structured_output: structured };
        try {
          options.onMessage?.(result);
        } catch (error) {
          appLog.error('[OMP] onMessage handler failed', error);
        }
      }
      return { ...outcome, aborted, timedOut, result };
    } finally {
      if (timer) clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onAbort);
      await cleanup();
    }
  })();

  // Live messages go to the RPC process (`send` is false in print mode: they wait in the task's inbox)
  return {
    get child() { return current!; },
    done,
    stop,
    send,
  };
}
