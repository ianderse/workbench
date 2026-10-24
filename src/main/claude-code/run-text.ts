/**
 * One-shot Claude Code calls
 * ==========================
 *
 * Small headless runs for app utilities (task triage, titles, terminal names, PR descriptions,
 * merge conflict resolution). Each call is a single `claude -p --output-format json` run that
 * is not saved as a session. Tools are off unless the caller asks for read-only exploration.
 */

import { resolveClaudeEnv } from './env';
import { startClaudeProcess } from './process';
import type { ClaudeEffort, ClaudeModelAlias } from '../../shared/types/claude-code';
import type { OmpBackendSettings } from '../../shared/types/agent-backend';
import type { ClaudeUserContentBlock } from './stream-types';
import { getAgentBackendSettings } from '../agent-backend/settings';
import { ompToolsFromClaude } from '../agent-backend/omp-args';
import { startOmpProcess } from '../agent-backend/omp-process';

/** Built-in tools for read-only exploration of a project */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export interface RunClaudeTextOptions {
  prompt: string | ClaudeUserContentBlock[];
  /** Appended to Claude Code's default system prompt */
  appendSystemPrompt?: string;
  /** Replaces Claude Code's system prompt (for non-coding utilities such as naming) */
  systemPrompt?: string;
  model?: ClaudeModelAlias | string;
  effort?: ClaudeEffort;
  /** JSON Schema: the run returns validated `structured` output */
  jsonSchema?: Record<string, unknown>;
  /** Working directory (defaults to the process cwd) */
  cwd?: string;
  /** Built-in tools to enable; empty (default) disables all tools */
  tools?: readonly string[];
  /** Extra allow rules, e.g. "Bash(git log *)" */
  allowedTools?: readonly string[];
  /** Expand Claude Code's slash commands in the prompt (off by default, so prompts stay literal) */
  slashCommands?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Claude profile to use (defaults to the best available one) */
  profileId?: string;
}

export interface RunClaudeTextResult {
  text: string;
  structured?: unknown;
  sessionId?: string;
  costUsd?: number;
}

/** Error from a one-shot Claude Code run */
class ClaudeCodeRunError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = 'ClaudeCodeRunError';
  }
}

/** Run Claude Code once and return its answer */
export async function runClaudeText(options: RunClaudeTextOptions): Promise<RunClaudeTextResult> {
  const backend = getAgentBackendSettings();
  if (backend.kind === 'omp') return runOmpText(options, backend.omp);

  const { command, env } = await resolveClaudeEnv({ profileId: options.profileId });
  const tools = options.tools ?? [];
  const usesContentBlocks = typeof options.prompt !== 'string';

  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--model', options.model ?? 'haiku',
    '--tools', tools.length > 0 ? tools.join(',') : '',
  ];
  if (!options.slashCommands) args.push('--disable-slash-commands');
  if (usesContentBlocks) args.push('--input-format', 'stream-json', '--verbose');
  if (options.effort) args.push('--effort', options.effort);
  if (options.allowedTools?.length) args.push('--allowedTools', ...options.allowedTools);
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  if (options.jsonSchema) args.push('--json-schema', JSON.stringify(options.jsonSchema));
  if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);

  const handle = startClaudeProcess({
    command,
    args,
    cwd: options.cwd ?? process.cwd(),
    env,
    input: options.prompt,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
  });
  return collectResult(await handle.done, 'Claude Code');
}

/** The answer of a finished run, or the error it ended with */
function collectResult(outcome: Awaited<ReturnType<typeof startClaudeProcess>['done']>, label: string): RunClaudeTextResult {
  if (outcome.aborted) {
    const error = new ClaudeCodeRunError(`${label} run was cancelled`);
    error.name = 'AbortError';
    throw error;
  }
  if (outcome.timedOut) throw new ClaudeCodeRunError(`${label} run timed out`, outcome.stderr);

  const result = outcome.result;
  if (!result) {
    throw new ClaudeCodeRunError(outcome.stderr.trim() || `${label} exited with code ${outcome.exitCode}`, outcome.stderr);
  }
  if (result.is_error || result.subtype !== 'success') {
    const message = result.errors?.join('; ') || result.result || `${label} failed (${result.subtype})`;
    throw new ClaudeCodeRunError(message, outcome.stderr);
  }
  return {
    text: result.result ?? '',
    structured: result.structured_output,
    sessionId: result.session_id,
    costUsd: result.total_cost_usd,
  };
}

/**
 * The same call through OMP (oh-my-pi): no session, utility mode (no extensions or skills).
 * OMP cannot scope Bash to a command prefix, so `Bash(git log *)` rules enable its bash tool whole;
 * `maxTurns` has no equivalent and the run is bounded by the timeout.
 */
async function runOmpText(options: RunClaudeTextOptions, settings: OmpBackendSettings): Promise<RunClaudeTextResult> {
  const handle = await startOmpProcess({
    settings,
    cwd: options.cwd ?? process.cwd(),
    prompt: options.prompt,
    model: options.model ?? 'haiku',
    effort: options.effort,
    tools: ompToolsFromClaude(options.tools, options.allowedTools),
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    jsonSchema: options.jsonSchema,
    oneShot: true,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
  });
  return collectResult(await handle.done, 'OMP');
}
