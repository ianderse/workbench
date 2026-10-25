/**
 * Claude Code stream-json message shapes
 * ======================================
 *
 * The subset of the Agent SDK message types (`SDKMessage`) that `claude -p
 * --output-format stream-json --verbose` emits and this app reads. Fields we don't use are
 * left out; unknown message types pass through as `ClaudeOtherMessage`.
 */

type ClaudeTextBlock = { type: 'text'; text: string };
type ClaudeThinkingBlock = { type: 'thinking'; thinking: string };
type ClaudeToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ClaudeToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
};

type ClaudeImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
/** PDF attachment */
type ClaudeDocumentBlock = { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string };

type ClaudeAssistantContentBlock = ClaudeTextBlock | ClaudeThinkingBlock | ClaudeToolUseBlock | { type: string };
export type ClaudeUserContentBlock = ClaudeTextBlock | ClaudeImageBlock | ClaudeDocumentBlock | ClaudeToolResultBlock;

export interface ClaudeSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  claude_code_version?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  agents?: string[];
  skills?: string[];
  slash_commands?: string[];
  mcp_servers?: { name: string; status: string }[];
  plugins?: { name: string; path: string }[];
}

export interface ClaudeTaskStartedMessage {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  ambient?: boolean;
}

export interface ClaudeTaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  ambient?: boolean;
}

export interface ClaudeApiRetryMessage {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error: string;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  session_id: string;
  parent_tool_use_id: string | null;
  message: { content: ClaudeAssistantContentBlock[]; model?: string };
  /** API error category, e.g. 'rate_limit', 'authentication_failed' */
  error?: string;
}

export interface ClaudeUserMessage {
  type: 'user';
  session_id?: string;
  parent_tool_use_id: string | null;
  message: { content: string | ClaudeUserContentBlock[] };
}

export interface ClaudeRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    /** Unix time in seconds */
    resetsAt?: number;
    utilization?: number;
  };
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  session_id: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  errors?: string[];
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  api_error_status?: number | null;
  terminal_reason?: string;
  permission_denials?: unknown[];
  /** OMP: the failed model replies of the run, `fallback` for those of a model OMP switched to */
  omp_errors?: Array<{ text: string; model?: string; fallback: boolean }>;
  /** Claude Code: tokens per model of the run (keys are model ids) */
  modelUsage?: Record<string, ClaudeModelUsage>;
  /** OMP: tokens per provider and model of the run */
  omp_usage?: OmpModelUsage[];
}

/** `modelUsage` entry of a Claude Code result */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/** What one OMP run spent on one model (summed over its replies) */
export interface OmpModelUsage {
  provider?: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** Time spent in replies, from the replies' own `duration` */
  durationMs: number;
  requests: number;
  failures: number;
  /** The model was an OMP fallback, not the one the run started on */
  fallback: boolean;
  /** Timestamps (ms) of the first and last reply */
  msFrom?: number;
  msTo?: number;
}

interface ClaudeOtherMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export type ClaudeStreamMessage =
  | ClaudeSystemInitMessage
  | ClaudeTaskStartedMessage
  | ClaudeTaskNotificationMessage
  | ClaudeApiRetryMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeRateLimitEvent
  | ClaudeResultMessage
  | ClaudeOtherMessage;

export function isInitMessage(m: ClaudeStreamMessage): m is ClaudeSystemInitMessage {
  return m.type === 'system' && m.subtype === 'init';
}
export function isAssistantMessage(m: ClaudeStreamMessage): m is ClaudeAssistantMessage {
  return m.type === 'assistant';
}
export function isUserMessage(m: ClaudeStreamMessage): m is ClaudeUserMessage {
  return m.type === 'user';
}
export function isResultMessage(m: ClaudeStreamMessage): m is ClaudeResultMessage {
  return m.type === 'result';
}
export function isRateLimitEvent(m: ClaudeStreamMessage): m is ClaudeRateLimitEvent {
  return m.type === 'rate_limit_event';
}
export function isTaskStarted(m: ClaudeStreamMessage): m is ClaudeTaskStartedMessage {
  return m.type === 'system' && m.subtype === 'task_started';
}
export function isTaskNotification(m: ClaudeStreamMessage): m is ClaudeTaskNotificationMessage {
  return m.type === 'system' && m.subtype === 'task_notification';
}
export function isApiRetry(m: ClaudeStreamMessage): m is ClaudeApiRetryMessage {
  return m.type === 'system' && m.subtype === 'api_retry';
}
