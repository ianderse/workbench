/**
 * OMP command line
 * ================
 *
 * Pure builders for `omp -p --mode json` arguments and the mapping from Workbench's Claude-shaped
 * options (model alias, effort, tool names) to OMP's.
 */

import { CLAUDE_MODEL_ALIASES, type ClaudeEffort, type ClaudeModelAlias } from '../../shared/types/claude-code';
import type { OmpAdvisorMode, OmpBackendSettings } from '../../shared/types/agent-backend';

/** OMP built-in tools that only read. `find` is not one: omp 18.11.0 refuses it in --tools ("Built-in tool unavailable") */
export const OMP_READ_ONLY_TOOLS: readonly string[] = ['read', 'grep', 'glob'];

/** Claude Code built-in tool -> OMP tools */
const CLAUDE_TO_OMP_TOOLS: Record<string, readonly string[]> = {
  Read: ['read'],
  Glob: ['glob'],
  Grep: ['grep'],
  LS: ['glob'],
  Bash: ['bash'],
  Edit: ['edit'],
  MultiEdit: ['edit'],
  Write: ['write'],
  WebSearch: ['web_search'],
  WebFetch: ['web_search'],
};

/** Tools that change state or run commands: a headless run needs approval switched off for them */
const MUTATING_OMP_TOOLS = new Set(['bash', 'edit', 'write']);

/**
 * OMP tool list for a one-shot call's Claude-style `tools` / `allowedTools`.
 * `Bash(git log *)` rules enable OMP's bash tool whole: OMP cannot scope bash to a command prefix.
 */
export function ompToolsFromClaude(tools: readonly string[] = [], allowedTools: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const entry of [...tools, ...allowedTools]) {
    const name = entry.replace(/\(.*$/, '').trim();
    for (const mapped of CLAUDE_TO_OMP_TOOLS[name] ?? []) out.add(mapped);
  }
  return [...out];
}

/** True when the tool list can change files or run commands */
export function needsAutoApprove(tools: 'all' | readonly string[]): boolean {
  return tools === 'all' || tools.some((tool) => MUTATING_OMP_TOOLS.has(tool));
}

/** The Workbench model tier a model string stands for ('haiku', 'claude-opus-4-1', ...), if any */
export function modelAliasOf(model: string | undefined): ClaudeModelAlias | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(lower)) return lower as ClaudeModelAlias;
  return CLAUDE_MODEL_ALIASES.find((alias) => lower.includes(alias));
}

/** `--model` value: the OMP model configured for the tier, or undefined for OMP's default */
export function ompModelFor(model: string | undefined, settings: OmpBackendSettings): string | undefined {
  const alias = modelAliasOf(model);
  const mapped = alias ? settings.models[alias]?.trim() : undefined;
  return mapped || undefined;
}

/**
 * Advisor handling for one run. One-shot utility calls (titles, commit messages, triage) never get the
 * advisor: they are cheap calls and must not burn the (usually remote) advisor model's quota.
 */
export function resolveOmpAdvisor(settings: OmpBackendSettings, oneShot?: boolean): { mode: OmpAdvisorMode; model?: string } {
  if (oneShot) return { mode: 'off' };
  const mode: OmpAdvisorMode = settings.advisor === 'on' || settings.advisor === 'off' ? settings.advisor : 'inherit';
  const model = settings.advisorModel?.trim();
  return { mode, ...(model ? { model } : {}) };
}

/**
 * Text of the `--config` overlay the advisor and fallback-model choices need, or undefined when the flags alone do it
 * (`on` without a model, or `inherit` without a model). OMP merges overlays over its config.
 * JSON strings are valid YAML scalars, so model ids are quoted with JSON.stringify.
 */
export function buildOmpAdvisorOverlay(
  advisor: { mode: OmpAdvisorMode; model?: string },
  allowFallbackModels = true,
): string | undefined {
  let advisorPart = '';
  if (advisor.mode === 'off') {
    advisorPart = 'advisor:\n  enabled: false\n';
  } else if (advisor.model) {
    const enable = advisor.mode === 'on' ? 'advisor:\n  enabled: true\n' : '';
    advisorPart = `modelRoles:\n  advisor: ${JSON.stringify(advisor.model)}\n${enable}`;
  }
  // `retry.modelFallback: false` stops OMP switching to the models of `retry.fallbackChains`
  // (verified against omp 18.11.0: a failing local model then surfaces its own error)
  const fallbackPart = allowFallbackModels ? '' : 'retry:\n  modelFallback: false\n';
  return `${advisorPart}${fallbackPart}` || undefined;
}

export interface OmpArgsOptions {
  settings: OmpBackendSettings;
  /** Workbench model tier or Claude model id */
  model?: string;
  effort?: ClaudeEffort;
  /** OMP tool names, or 'all' for OMP's default set */
  tools: 'all' | readonly string[];
  /** Skip approval prompts (no one can answer them in a headless run) */
  autoApprove?: boolean;
  /** File (or text) replacing OMP's system prompt */
  systemPromptFile?: string;
  /** File (or text) appended to OMP's system prompt */
  appendSystemPromptFile?: string;
  /** Persist the session in `dir` (and continue `resume`); undefined = `--no-session` */
  session?: { dir: string; resume?: string };
  maxTimeMinutes?: number;
  /** Utility call: skip extension and skill discovery to keep small models focused */
  oneShot?: boolean;
  /** Advisor mode (`on` adds `--advisor`); default `inherit` */
  advisorMode?: OmpAdvisorMode;
  /** Config overlay file made from `buildOmpAdvisorOverlay` (`--config`) */
  advisorOverlayFile?: string;
  /** Files attached to the message (`@path`) */
  attachmentPaths?: readonly string[];
}

export function buildOmpArgs(options: OmpArgsOptions): string[] {
  const { settings } = options;
  const args = ['-p', '--mode', 'json', '--no-title'];
  if (options.session) {
    args.push('--session-dir', options.session.dir);
    if (options.session.resume) args.push('--resume', options.session.resume);
  } else {
    args.push('--no-session');
  }
  const model = ompModelFor(options.model, settings);
  if (model) args.push('--model', model);
  const thinking = options.effort ? settings.thinking[options.effort] : undefined;
  if (thinking) args.push('--thinking', thinking);
  if (options.tools === 'all') {
    // OMP's default tool set
  } else if (options.tools.length === 0) {
    args.push('--no-tools');
  } else {
    args.push('--tools', options.tools.join(','));
  }
  if (options.autoApprove ?? needsAutoApprove(options.tools)) args.push('--auto-approve');
  if (options.systemPromptFile) args.push('--system-prompt', options.systemPromptFile);
  if (options.appendSystemPromptFile) args.push('--append-system-prompt', options.appendSystemPromptFile);
  if (options.maxTimeMinutes && options.maxTimeMinutes > 0) args.push('--max-time', `${Math.ceil(options.maxTimeMinutes)}m`);
  if (options.oneShot) args.push('--no-extensions', '--no-skills');
  if (options.advisorMode === 'on') args.push('--advisor');
  if (options.advisorOverlayFile) args.push('--config', options.advisorOverlayFile);
  if (settings.extraArgs?.length) args.push(...settings.extraArgs);
  if (options.attachmentPaths?.length) args.push(...options.attachmentPaths.map((p) => `@${p}`));
  return args;
}
