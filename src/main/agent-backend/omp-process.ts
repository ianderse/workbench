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
 * A caller's JSON schema is put into the prompt (OMP has no `--json-schema`); when the final
 * answer has no parseable object the run is repeated once, asking for the JSON alone.
 */

import type { ChildProcess } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { appLog } from '../app-logger';
import { getExecutableExtension, getPathDelimiter } from '../platform';
import { killRuntimeProcess, spawnTool } from '../platform/runtime-exec';
import type { ClaudeProcessHandle } from '../claude-code/process';
import type { ClaudeResultMessage, ClaudeStreamMessage, ClaudeUserContentBlock } from '../claude-code/stream-types';
import type { ClaudeEffort } from '../../shared/types/claude-code';
import type { OmpBackendSettings } from '../../shared/types/agent-backend';
import { buildOmpAdvisorOverlay, buildOmpArgs, ompModelFor, resolveOmpAdvisor } from './omp-args';
import { buildJsonRepairPrompt, buildStructuredInstruction, parseStructuredOutput } from './omp-structured';
import { createOmpTranslator, isOmpNotice } from './omp-translate';

type OmpProcessOutcome = Awaited<ClaudeProcessHandle['done']>;

export interface OmpRunOptions {
  settings: OmpBackendSettings;
  cwd: string;
  /** Extra environment on top of the app's own */
  env?: Record<string, string>;
  prompt: string | ClaudeUserContentBlock[];
  /** Workbench model tier or Claude model id (mapped through the settings) */
  model?: string;
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
}

/** Directories searched for `omp` when the app (started from Finder/Explorer) has a minimal PATH */
function extraSearchDirs(): string[] {
  const home = os.homedir();
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the OMP executable (settings command, PATH, then common install folders) */
export async function resolveOmpCommand(configured: string | undefined, envPath: string | undefined = process.env.PATH): Promise<string> {
  const command = configured?.trim() || 'omp';
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;
  const ext = getExecutableExtension();
  const names = ext ? [`${command}${ext}`, `${command}.cmd`, command] : [command];
  const dirs = [...(envPath ?? '').split(getPathDelimiter()).filter(Boolean), ...extraSearchDirs()];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return command; // let the spawn fail with a readable "not found"
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
  const command = await resolveOmpCommand(options.settings.command, options.env?.PATH ?? process.env.PATH);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'workbench-omp-'));
  const cleanup = () => rm(tempDir, { recursive: true, force: true }).catch(() => undefined);

  let setup: {
    text: string;
    attachmentPaths: string[];
    systemPromptFile?: string;
    appendSystemPromptFile?: string;
    advisorOverlayFile?: string;
  };
  // One-shot utility calls never use the advisor; the setting applies to the other runs
  const advisor = resolveOmpAdvisor(options.settings, options.oneShot);
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
    if (options.appendSystemPrompt) {
      appendSystemPromptFile = path.join(tempDir, 'append-system-prompt.md');
      await writeFile(appendSystemPromptFile, options.appendSystemPrompt, 'utf-8');
    }
    let advisorOverlayFile: string | undefined;
    const advisorOverlay = buildOmpAdvisorOverlay(advisor, options.settings.allowFallbackModels === true);
    if (advisorOverlay) {
      advisorOverlayFile = path.join(tempDir, 'advisor-overlay.yml');
      await writeFile(advisorOverlayFile, advisorOverlay, 'utf-8');
    }
    setup = {
      advisorOverlayFile,
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

  /** One `omp` process: stdin text + attachments in, translated messages out */
  const runOnce = (args: string[], input: string, holdResult: boolean, resumeNote?: string) => {
    // `spawnTool` names only the tools cli-tool-manager knows; `command` is what runs
    // (inside WSL it must be an absolute Linux path)
    const child = spawnTool('claude', args, { command, cwd: options.cwd, env, windowsHide: true, stdio: 'pipe' });
    current = child;
    if (resumeNote) appLog.info(`[OMP] ${resumeNote}`);
    return new Promise<{ outcome: Omit<OmpProcessOutcome, 'result'>; result?: ClaudeResultMessage; text: string; sessionId?: string }>((resolve) => {
      const translator = createOmpTranslator({ model: ompModelFor(options.model, options.settings), emitDeltas: options.emitDeltas, emitProgress: options.emitProgress });
      let buffer = '';
      let stderr = '';
      let held: ClaudeResultMessage | undefined;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') return;
        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return;
        }
        for (const message of translator.translate(event)) {
          if (isOmpNotice(message)) {
            if (options.oneShot) appLog.warn(`[OMP] Notice (${message.source}): ${message.text}`);
          }
          if (message.type === 'result') {
            held = message as ClaudeResultMessage;
            if (!holdResult) forward(message);
          } else {
            forward(message);
          }
        }
      };
      const forward = (message: ClaudeStreamMessage) => {
        try {
          options.onMessage?.(message);
        } catch (error) {
          appLog.error('[OMP] onMessage handler failed', error);
        }
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
        if (buffer.trim()) handleLine(buffer);
        buffer = '';
        let result = held;
        if (!result) {
          result = translator.finalize({ exitCode, stderr, aborted, timedOut });
          if (result && !holdResult) forward(result);
        }
        resolve({ outcome: { exitCode, signal, stderr, aborted, timedOut }, result, text: translator.lastText, sessionId: translator.sessionId });
      };
      child.on('error', (error) => {
        stderr = (stderr + `\n${error.message}`).slice(-8000);
        finish(null, null);
      });
      child.on('close', (code, signal) => finish(code, signal));

      child.stdin?.on('error', () => { /* process exited before reading stdin */ });
      child.stdin?.end(input);
    });
  };

  const baseArgs = buildOmpArgs({
    settings: options.settings,
    model: options.model,
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
    attachmentPaths: setup.attachmentPaths,
  });

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

  const first = runOnce(baseArgs, setup.text, !!options.jsonSchema);
  const firstChild = current!;
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
            effort: options.effort,
            tools: [],
            session: resumeSession,
            maxTimeMinutes: options.maxTimeMinutes,
            oneShot: options.oneShot,
            advisorMode: advisor.mode,
            advisorOverlayFile: setup.advisorOverlayFile,
          });
          const repair = await runOnce(
            repairArgs,
            buildJsonRepairPrompt(schema, resumeSession ? undefined : run.text),
            true,
            'The answer had no valid JSON, asking once more for the JSON alone',
          );
          outcome = repair.outcome;
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

  return { child: firstChild, done, stop };
}
