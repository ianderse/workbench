/**
 * OMP RPC transport (pure parts)
 * ==============================
 *
 * `omp --mode rpc --no-ui` keeps a session open on stdin/stdout so a message can be injected into a
 * running step. Facts verified live against omp 18.12.6 (probes with `--tools bash` and a local model):
 *
 * Framing
 *  - Protocol v1 is plain JSON lines both ways (one object per line, `\n` terminated). The first
 *    stdout line is `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],...}`;
 *    commands written before that are still read, but we wait for `ready` so a start failure is seen.
 *  - Commands carry an `id`; the answer is `{"id","type":"response","command","success":true|false,
 *    "error"?,"data"?}`. Everything else is an event without `id`.
 *
 * Starting a run
 *  - `{"id","type":"get_state"}` -> response `data.sessionId` (also `sessionFile`, the model, ...). There is no
 *    `session` event in RPC mode (print mode starts with one), so the session id comes from here. It is
 *    answered at once while idle (the data is large, about 30 KB with the system prompt and tool list).
 *  - `{"id","type":"prompt","message":"..."}` -> `response` (success) then `agent_start`, `turn_start`, ... The
 *    events are the same objects `--mode json` prints (`message_start/update/end`, `tool_execution_*`,
 *    `turn_end`, `agent_end`, `auto_retry_start`, `notice`, ...) so the print translator (omp-translate.ts)
 *    is used unchanged. Extra RPC-only events: `ready`, `available_commands_update`, `model_changed`,
 *    `queue_update`, `prompt_result`, `session_settled`.
 *  - Completion: `agent_end`, then `prompt_result {id, status: completed|aborted, sessionSettled}`, then
 *    `session_settled`. The process does NOT exit; it waits for more commands. Closing stdin ends it
 *    (exit code 0, within about 0.5 s), also in the middle of a run. So Workbench closes stdin after
 *    `session_settled`.
 *  - `--session-dir`, `--resume <id>`, `--tools`, `--no-tools`, `-e`, `--config`, `--model @role`,
 *    `--thinking`, `--append-system-prompt`, `--system-prompt`, `--auto-approve` and `--max-time` all work as
 *    in print mode (resume keeps the earlier conversation). `@file` attachments do NOT: omp exits 1 with
 *    "@file arguments are not supported in RPC mode", so a run with attachments uses print mode.
 *
 * Steering
 *  - `{"id","type":"steer","message":"..."}` -> immediate `queue_update {steering:[msg]}` and `response`.
 *    The message is injected at the next turn boundary of the running agent: a bash call that was running
 *    is backgrounded ("Backgrounded early to handle an incoming message") and, after that tool result and
 *    `turn_end`, the next turn starts with `message_start`/`message_end` of
 *    `{role:"user", attribution:"user", content:[{type:"text", text:<our text>}]}`. That event is the read
 *    receipt (our text carries a `[Workbench message wbm-...]` marker). Verified: the model then acted on it
 *    within the same run (ran the extra command it asked for and mentioned it in its answer).
 *  - `{"type":"follow_up","message"}` sent after `agent_end` while idle starts a new agent run at once
 *    (`queue_update`, `response`, `agent_start`, user `message_end`, ..., `agent_end`, `session_settled`); there is no
 *    `prompt_result` for it. Workbench does not use it (a run has one prompt; late messages go back to the inbox).
 *
 * Abort
 *  - `{"id","type":"abort"}` -> the running tool ends ("Command aborted"), an empty assistant turn, `agent_end`,
 *    `response abort`, `prompt_result {status:"aborted"}`, `session_settled`. Workbench stops runs with the
 *    existing kill path (killRuntimeProcess) instead, as in print mode; the translator reports "aborted".
 *
 * Slow start (verified 2026-10-25, omp 18.12.6)
 *  - The `response` to a `prompt` is written at once (about 10 ms after the command, `success: true`) and
 *    `agent_start` follows within about 20 ms when the context fits (`ready`, `model_changed`,
 *    `available_commands_update`, `response`, `agent_start`, `turn_start`, user `message_start/end`, ...).
 *  - When the resumed session does not fit the model's window, omp logs "Pre-prompt context maintenance triggered
 *    by pending prompt size" and compacts BEFORE `agent_start`; with a local model that took over 55 s (production
 *    log, 162k tokens into a 128k window). The `response` is already out by then, so a successful response means the
 *    prompt is accepted and a slow start is not a failed start. The omp binary has `auto_compaction_start` and
 *    `auto_compaction_end` events (not captured live here: forcing a compaction needs an over-full session), so
 *    compaction/maintenance/queue events also count as working (`isWorkingEvent`). Only a stdout that stays
 *    silent for a long time before `agent_start` is given up (hang guard, no -p fallback: print mode would compact
 *    again and lose the live messages).
 *
 * Not verified: protocol v2 framing (we stay on v1), `images` on prompt (attachments use print mode).
 */

/** Parsed stdout line */
export type RpcLine =
  | { kind: 'ready' }
  | { kind: 'response'; id: string; command: string; success: boolean; error?: string; data?: unknown }
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'invalid' };

/** One JSON command line, newline terminated */
export function encodeRpcCommand(command: Record<string, unknown>): string {
  return `${JSON.stringify(command)}\n`;
}

/** Parse a stdout line; blank lines are `undefined`, anything that is not a JSON object is `invalid` */
export function parseRpcLine(line: string): RpcLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (trimmed[0] !== '{') return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' };
  const record = value as Record<string, unknown>;
  if (record.type === 'ready') return { kind: 'ready' };
  if (record.type === 'response' && typeof record.id === 'string') {
    return {
      kind: 'response',
      id: record.id,
      command: typeof record.command === 'string' ? record.command : '',
      success: record.success === true,
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
      ...('data' in record ? { data: record.data } : {}),
    };
  }
  return { kind: 'event', event: record };
}

export const RPC_STATE_ID = 'wb-state';
export const RPC_PROMPT_ID = 'wb-prompt';

export const rpcGetState = () => encodeRpcCommand({ id: RPC_STATE_ID, type: 'get_state' });
export const rpcPrompt = (message: string) => encodeRpcCommand({ id: RPC_PROMPT_ID, type: 'prompt', message });
export const rpcSteer = (id: string, message: string) => encodeRpcCommand({ id: `steer-${id}`, type: 'steer', message });

const MESSAGE_MARKER = /\[Workbench message (wbm-[A-Za-z0-9_-]+)\]/;

/** The steer text: the message plus the marker that lets the injected user message be matched to it */
export function steerText(text: string, id: string): string {
  return `${text}\n\n[Workbench message ${id}]`;
}

/** Text of a message's content (string or blocks) */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

/** The id of the steer message a `message_end` event of a user message carries, if it is one of ours */
export function readSteerId(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'message_end') return undefined;
  const message = event.message as { role?: unknown; attribution?: unknown; content?: unknown } | undefined;
  if (!message || message.role !== 'user') return undefined;
  return MESSAGE_MARKER.exec(contentText(message.content))?.[1];
}

/** True for the event after which the process can be closed: the session has nothing left to do */
export function isSessionSettled(event: Record<string, unknown>): boolean {
  return event.type === 'session_settled';
}

/**
 * True for an event that shows the session is working on an accepted prompt even though `agent_start` has not
 * come yet: omp compacts or trims the context first when the resumed session does not fit the model's window
 */
export function isWorkingEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === 'string' ? event.type : '';
  return type === 'agent_start' || type === 'queue_update' || /compaction|maintenance|^auto_retry/.test(type);
}

/** The session id in a `get_state` response, if any */
export function sessionIdOf(data: unknown): string | undefined {
  const id = (data as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === 'string' && id ? id : undefined;
}
