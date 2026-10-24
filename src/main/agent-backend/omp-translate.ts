/**
 * OMP event stream -> Claude Code stream messages
 * ===============================================
 *
 * `omp -p --mode json` prints one JSON event per line (pi-agent events: `session`, `message_end`,
 * `tool_execution_*`, `agent_end`, ...). The task runner, the task log and Insights all read
 * Claude Code's stream-json shapes, so this adapter translates each OMP event into zero or more
 * `ClaudeStreamMessage`s instead of teaching them a second protocol. Pure and defensive: unknown
 * events are ignored and missing fields tolerated.
 *
 * Verified against omp 18.11.0 (event construction in the binary and a live error run):
 * - assistant content blocks: `{type:'text'|'thinking'|'toolCall', ...}`; toolCall has `id`,
 *   `name`, `arguments`
 * - tool results arrive as `message_end` of a `role:'toolResult'` message with `toolCallId`,
 *   `toolName`, `content[]`, `details`, `isError`
 * - `auto_retry_start`: `attempt`, `maxAttempts`, `delayMs`, `errorMessage`
 * - `notice`: `level` ('info'|'warning'|'error'), `message`, `source` (e.g. 'advisor'); verified live
 * - advisor notes (binary: advisor runtime; live): a `message_end` of `role:'custom'`,
 *   `customType:'advisor'`, `content` (text of all notes), `details.notes[]` = `{note, severity?, advisor?}`;
 *   `advisor_yielded` / `advisor_cost_changed` are bookkeeping events and are ignored
 * - `agent_end`: `messages` (the messages of this run)
 */

import type { ClaudeResultMessage, ClaudeStreamMessage } from '../claude-code/stream-types';

/** Custom message: streaming text of the assistant (only with `emitDeltas`) */
export interface OmpTextDeltaMessage {
  type: 'omp_text_delta';
  text: string;
}

/**
 * Custom message: a streamed chunk of the reply in progress (only with `emitProgress`), for a
 * "model is writing" indicator. Carries sizes only, not the text.
 */
export interface OmpProgressMessage {
  type: 'system';
  subtype: 'omp_progress';
  kind: 'text' | 'thinking' | 'toolcall';
  chars: number;
}

export function isOmpProgress(message: ClaudeStreamMessage): message is ClaudeStreamMessage & OmpProgressMessage {
  return message.type === 'system' && (message as { subtype?: string }).subtype === 'omp_progress';
}

/** Custom message: the whole todo list after a `todo` tool call (mirrored as the task's subtasks) */
export interface OmpTodosMessage {
  type: 'system';
  subtype: 'omp_todos';
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}

/**
 * Custom message: something OMP wants the user to see that is not part of the answer: a `notice`
 * event (advisor quota exhausted, compaction warnings, ...) or a note from the advisor model.
 */
export interface OmpNoticeMessage {
  type: 'system';
  subtype: 'omp_notice';
  level: 'info' | 'warning' | 'error';
  /** Where it came from: 'advisor' for advisor notes and advisor notices, else OMP's notice source */
  source: string;
  text: string;
  /** Advisor note severity (e.g. 'concern', 'blocker') */
  severity?: string;
  /** Name of the advisor that wrote the note (unset for the default advisor) */
  advisor?: string;
}

export function isOmpNotice(message: ClaudeStreamMessage): message is ClaudeStreamMessage & OmpNoticeMessage {
  return message.type === 'system' && (message as { subtype?: string }).subtype === 'omp_notice';
}

export function isOmpTextDelta(message: ClaudeStreamMessage): message is ClaudeStreamMessage & OmpTextDeltaMessage {
  return message.type === 'omp_text_delta';
}

export function isOmpTodos(message: ClaudeStreamMessage): message is ClaudeStreamMessage & OmpTodosMessage {
  return message.type === 'system' && (message as { subtype?: string }).subtype === 'omp_todos';
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// =============================================================================
// Tool names and inputs
// =============================================================================

/** OMP tool name -> the Claude Code tool the task runner and log know */
const TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  ast_edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  ast_grep: 'Grep',
  find: 'Glob',
  glob: 'Glob',
  todo: 'TodoWrite',
  web_search: 'WebSearch',
  task: 'Task',
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name.toLowerCase()] ?? name;
}

/** Paths a patch-style edit (`input` text) touches: `[x#9CE3]` (hashline), `*** Update File: x`, `+++ b/x` */
function pathsFromPatch(input: string): string[] {
  const paths = new Set<string>();
  for (const match of input.matchAll(/^\[([^\]\n#]+)#[0-9A-Za-z]+\]\s*$/gm)) paths.add(match[1].trim());
  for (const match of input.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) paths.add(match[1].trim());
  for (const match of input.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (match[1] !== '/dev/null') paths.add(match[1]);
  return [...paths];
}

/** Strip a trailing selector from a read path (`src/a.ts:10-20`) */
function cleanPath(value: string): string {
  return value.replace(/:(\d+)(?:[-+]\d+)?$/, '');
}

/**
 * Tool input in Claude Code's field names, so the log summary and the files-edited hook work:
 * `path` -> `file_path`, patch-style edits expose the files they touch, `find`/`glob` keep their
 * `pattern`.
 */
export function normalizeToolInput(claudeName: string, args: Json): Json {
  const input: Json = { ...args };
  const path = asString(args.path) ?? asString(args.file) ?? asString(args.filePath);
  if (input.file_path === undefined && path) input.file_path = claudeName === 'Read' ? cleanPath(path) : path;
  if (claudeName === 'Edit' || claudeName === 'Write') {
    const patch = asString(args.input);
    if (patch) {
      const files = pathsFromPatch(patch);
      if (files.length > 0) {
        if (input.file_path === undefined) input.file_path = files[0];
        if (files.length > 1) input.file_paths = files;
      }
    }
    if (Array.isArray(args.paths)) {
      const files = args.paths.filter((p): p is string => typeof p === 'string');
      if (files.length > 0) {
        if (input.file_path === undefined) input.file_path = files[0];
        if (files.length > 1) input.file_paths = files;
      }
    }
  }
  if (claudeName === 'Bash' && input.description === undefined && typeof args.intent === 'string') input.description = args.intent;
  if ((claudeName === 'Glob' || claudeName === 'Grep') && input.pattern === undefined) {
    const pattern = asString(args.query) ?? asString(args.regex);
    if (pattern) input.pattern = pattern;
  }
  return input;
}

// =============================================================================
// Content
// =============================================================================

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record && record.type === 'text' ? asString(record.text) ?? '' : '';
    })
    .filter(Boolean)
    .join('\n');
}

function noticeMessage(notice: Omit<OmpNoticeMessage, 'type' | 'subtype'>): ClaudeStreamMessage {
  return { type: 'system', subtype: 'omp_notice', ...notice } as OmpNoticeMessage as unknown as ClaudeStreamMessage;
}

/** One notice per note of an advisor card (`customType:'advisor'`) */
function advisorNotes(message: Json): ClaudeStreamMessage[] {
  const notes = asRecord(message.details)?.notes;
  const out: ClaudeStreamMessage[] = [];
  if (Array.isArray(notes)) {
    for (const raw of notes) {
      const note = asRecord(raw);
      const text = (asString(note?.note) ?? '').trim();
      if (!text) continue;
      const severity = asString(note?.severity);
      const advisor = asString(note?.advisor);
      out.push(noticeMessage({
        level: severity === 'blocker' ? 'error' : severity === 'concern' ? 'warning' : 'info',
        source: 'advisor',
        text,
        ...(severity ? { severity } : {}),
        ...(advisor && advisor !== 'default' ? { advisor } : {}),
      }));
    }
  }
  if (out.length === 0) {
    const text = textOf(message.content).trim();
    if (text) out.push(noticeMessage({ level: 'info', source: 'advisor', text }));
  }
  return out;
}

function todosFrom(details: unknown): OmpTodosMessage['todos'] | undefined {
  const phases = asRecord(details)?.phases;
  if (!Array.isArray(phases)) return undefined;
  const todos: OmpTodosMessage['todos'] = [];
  for (const phase of phases) {
    const tasks = asRecord(phase)?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const record = asRecord(task);
      const content = asString(record?.content);
      if (!content) continue;
      const status = record?.status;
      if (status === 'abandoned') continue;
      todos.push({
        content,
        status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
      });
    }
  }
  return todos;
}

// =============================================================================
// Translator
// =============================================================================

export interface OmpTranslatorOptions {
  /** Model passed to OMP (shown in the init message until a reply names the real one) */
  model?: string;
  /** Also emit `omp_text_delta` messages for streamed text (Insights) */
  emitDeltas?: boolean;
  /** Emit `omp_progress` messages (sizes only) for text, thinking and tool-call deltas */
  emitProgress?: boolean;
}

export interface OmpTranslator {
  /** Translate one parsed OMP event */
  translate(event: unknown): ClaudeStreamMessage[];
  /**
   * The result message when `agent_end` never came (process died, was killed or timed out).
   * Returns undefined when a result was already produced.
   */
  finalize(info: { exitCode: number | null; stderr?: string; aborted?: boolean; timedOut?: boolean }): ClaudeResultMessage | undefined;
  /** Session id announced by OMP's `session` event */
  readonly sessionId: string | undefined;
  /** Text of the last assistant message so far */
  readonly lastText: string;
  /** Every failed assistant message so far, oldest first, with the model that failed */
  readonly errors: ReadonlyArray<OmpModelError>;
}

/** A failed model reply; `fallback` when OMP had switched to a fallback model by then */
export interface OmpModelError {
  text: string;
  model?: string;
  fallback: boolean;
}

export function createOmpTranslator(options: OmpTranslatorOptions = {}): OmpTranslator {
  const startedAt = Date.now();
  let sessionId: string | undefined;
  let model = options.model;
  let lastAssistant: Json | undefined;
  let totalCost = 0;
  let turns = 0;
  let resultEmitted = false;
  let lastText = '';
  let onFallback = false;
  const errors: OmpModelError[] = [];

  const buildResult = (extra?: { error?: string }): ClaudeResultMessage => {
    const stopReason = asString(lastAssistant?.stopReason);
    const errorMessage = extra?.error ?? asString(lastAssistant?.errorMessage);
    const failed = stopReason === 'error' || stopReason === 'aborted' || !!extra?.error;
    const result: ClaudeResultMessage = {
      type: 'result',
      subtype: failed ? 'error_during_execution' : 'success',
      session_id: sessionId ?? '',
      is_error: failed,
      result: lastText,
      omp_errors: errors.map((e) => ({ ...e })),
      total_cost_usd: totalCost,
      duration_ms: Date.now() - startedAt,
      num_turns: turns,
    };
    if (failed) {
      result.errors = [errorMessage || (stopReason === 'aborted' ? 'The run was aborted' : 'OMP stopped with an error')];
      if (stopReason) result.terminal_reason = stopReason;
    }
    return result;
  };

  const translateAssistant = (message: Json): ClaudeStreamMessage[] => {
    lastAssistant = message;
    turns++;
    const usage = asRecord(message.usage);
    const cost = asRecord(usage?.cost);
    if (typeof cost?.total === 'number' && Number.isFinite(cost.total)) totalCost += cost.total;
    const messageModel = asString(message.model);
    if (messageModel) model = asString(message.provider) ? `${message.provider}/${messageModel}` : messageModel;

    const blocks: Array<Json> = [];
    const texts: string[] = [];
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
        texts.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        blocks.push({ type: 'thinking', thinking: block.thinking });
      } else if (block.type === 'toolCall') {
        const ompName = asString(block.name) ?? 'tool';
        const name = normalizeToolName(ompName);
        blocks.push({
          type: 'tool_use',
          id: asString(block.id) ?? `omp-tool-${blocks.length}`,
          name,
          input: normalizeToolInput(name, asRecord(block.arguments) ?? {}),
        });
      }
    }
    lastText = texts.join('\n').trim();
    const error = message.stopReason === 'error' ? asString(message.errorMessage) || 'OMP request failed' : undefined;
    if (error) errors.push({ text: error, ...(model ? { model } : {}), fallback: onFallback });
    if (blocks.length === 0 && !error) return [];
    const out: ClaudeStreamMessage = {
      type: 'assistant',
      session_id: sessionId ?? '',
      parent_tool_use_id: null,
      message: { content: blocks as never, ...(model ? { model } : {}) },
      ...(error ? { error } : {}),
    };
    return [out];
  };

  const translateToolResult = (message: Json): ClaudeStreamMessage[] => {
    const text = textOf(message.content);
    const out: ClaudeStreamMessage[] = [{
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: asString(message.toolCallId) ?? '',
          content: text,
          is_error: message.isError === true,
        }],
      },
    }];
    if (message.toolName === 'todo' && message.isError !== true) {
      const todos = todosFrom(message.details);
      if (todos) out.push({ type: 'system', subtype: 'omp_todos', todos } as OmpTodosMessage as unknown as ClaudeStreamMessage);
    }
    return out;
  };

  return {
    get sessionId() { return sessionId; },
    get lastText() { return lastText; },
    get errors() { return errors; },

    translate(event: unknown): ClaudeStreamMessage[] {
      const e = asRecord(event);
      if (!e) return [];
      switch (e.type) {
        case 'session': {
          sessionId = asString(e.id) ?? sessionId;
          return [{
            type: 'system',
            subtype: 'init',
            session_id: sessionId ?? '',
            cwd: asString(e.cwd),
            model,
            tools: [],
          }];
        }
        case 'message_end': {
          const message = asRecord(e.message);
          if (!message) return [];
          if (message.role === 'assistant') return translateAssistant(message);
          if (message.role === 'toolResult') return translateToolResult(message);
          // Advisor notes are injected as a custom message: never the answer (`lastText`/`result`)
          if (message.role === 'custom' && message.customType === 'advisor') return advisorNotes(message);
          return [];
        }
        case 'message_update': {
          if (!options.emitDeltas && !options.emitProgress) return [];
          const inner = asRecord(e.assistantMessageEvent);
          if (options.emitProgress) {
            const kind = inner?.type === 'text_delta' ? 'text'
              : inner?.type === 'thinking_delta' ? 'thinking'
                : inner?.type === 'toolcall_delta' ? 'toolcall' : undefined;
            const delta = typeof inner?.delta === 'string' ? inner.delta : '';
            const out: ClaudeStreamMessage[] = [];
            if (kind && delta) out.push({ type: 'system', subtype: 'omp_progress', kind, chars: delta.length } as OmpProgressMessage as unknown as ClaudeStreamMessage);
            if (options.emitDeltas && inner?.type === 'text_delta' && delta) {
              out.push({ type: 'omp_text_delta', text: delta } as OmpTextDeltaMessage as unknown as ClaudeStreamMessage);
            }
            return out;
          }
          if (inner?.type === 'text_delta' && typeof inner.delta === 'string' && inner.delta) {
            return [{ type: 'omp_text_delta', text: inner.delta } as OmpTextDeltaMessage as unknown as ClaudeStreamMessage];
          }
          return [];
        }
        case 'model_change': {
          // OMP switched models on its own after a provider error (`role: 'fallback'`)
          if (e.role !== 'fallback') return [];
          onFallback = true;
          const target = asString(e.model) ?? 'another model';
          const cause = errors.at(-1)?.text;
          return [noticeMessage({
            level: 'warning',
            source: 'omp',
            text: `OMP switched to fallback model ${target}${cause ? ` after: ${cause}` : ''}`,
          })];
        }
        case 'notice': {
          const text = (asString(e.message) ?? '').trim();
          if (!text) return [];
          const level = e.level === 'error' || e.level === 'warning' ? e.level : 'info';
          return [noticeMessage({ level, source: asString(e.source) ?? 'omp', text })];
        }
        case 'auto_retry_start': {
          return [{
            type: 'system',
            subtype: 'api_retry',
            attempt: typeof e.attempt === 'number' ? e.attempt : 1,
            max_retries: typeof e.maxAttempts === 'number' ? e.maxAttempts : 0,
            retry_delay_ms: typeof e.delayMs === 'number' ? e.delayMs : 0,
            error: asString(e.errorMessage) ?? 'request failed',
          }];
        }
        case 'agent_end': {
          if (resultEmitted) return [];
          // Messages the stream missed (a run that ended before message_end) still count
          if (!lastAssistant && Array.isArray(e.messages)) {
            for (let i = e.messages.length - 1; i >= 0; i--) {
              const m = asRecord(e.messages[i]);
              if (m?.role === 'assistant') {
                translateAssistant(m);
                break;
              }
            }
          }
          resultEmitted = true;
          return [buildResult()];
        }
        default:
          return [];
      }
    },

    finalize(info): ClaudeResultMessage | undefined {
      if (resultEmitted) return undefined;
      resultEmitted = true;
      let error: string | undefined;
      if (info.timedOut) error = 'OMP run timed out';
      else if (info.aborted) error = 'The run was aborted';
      else if (info.exitCode !== 0 || !lastAssistant) {
        const tail = info.stderr?.trim().split('\n').slice(-3).join(' ');
        error = tail || `OMP exited with code ${info.exitCode}`;
      }
      return buildResult(error ? { error } : undefined);
    },
  };
}
