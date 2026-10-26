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

/** OMP model roles Workbench picks by job (`omp --model @<role>`) */
export type OmpRole = 'default' | 'plan' | 'judge' | 'tiny' | 'design';

/** Role name -> model selector, from the user's OMP config (`modelRoles`) */
export type OmpRoleMap = Readonly<Record<string, string>>;

/** The kinds of work a run can be for; each has an OMP role */
export type OmpJob = 'plan' | 'implement' | 'validate' | 'revise' | 'resync' | 'review' | 'spec_review' | 'utility' | 'design';

/** OMP role for a job: design -> design, plan and spec_review -> plan, review -> judge, everything else -> default */
export function ompRoleForJob(job: OmpJob): OmpRole {
  if (job === 'design') return 'design';
  if (job === 'plan' || job === 'spec_review') return 'plan';
  if (job === 'review') return 'judge';
  return 'default';
}

/** Roles tried after a role the OMP config does not define, before `default`: UI design falls back to the plan role */
const OMP_ROLE_FALLBACKS: Readonly<Record<string, readonly string[]>> = { design: ['plan'] };

/** The role (the given one, else its fallbacks) the OMP config defines, or undefined; never `default` */
export function ompConfiguredRole(role: string, roles: OmpRoleMap | undefined): string | undefined {
  if (!roles) return undefined;
  return [role, ...(OMP_ROLE_FALLBACKS[role] ?? [])].find((name) => roles[name]?.trim());
}

/**
 * `--model @<role>` for a role the user's OMP config defines. omp 18.11.0 fails with "Model not found"
 * for an undefined role, so a missing role falls back to `@default`, and to nothing (OMP's own
 * default) when no roles are known yet or `default` is not defined either.
 */
export function ompRoleSelector(role: string, roles: OmpRoleMap | undefined): string | undefined {
  if (!roles) return undefined;
  const configured = ompConfiguredRole(role, roles);
  if (configured) return `@${configured}`;
  if (roles.default?.trim()) return '@default';
  return undefined;
}

export interface OmpModelSelection {
  /** Value for `--model`, undefined = leave it to OMP */
  selector?: string;
  /** Where the choice came from */
  source: 'pin' | 'size' | 'role' | 'none';
  /** Role used when `source` is `role` */
  role?: string;
  /** The model that will run, when known */
  concrete?: string;
}

/**
 * Which OMP model a run uses. Order: an exact `provider/model` pin, the Workbench size mapping
 * (`omp.models`), then the OMP role for the job (only roles the OMP config defines), then nothing.
 */
export function resolveOmpSelection(
  model: string | undefined,
  settings: OmpBackendSettings,
  role?: string,
  roles?: OmpRoleMap,
): OmpModelSelection {
  // An exact OMP selector (`provider/model`) the user pinned goes straight to `--model`;
  // Claude ids (`claude-opus-4-1`) have no slash and still map through their tier
  if (model && model.includes('/')) return { selector: model.trim(), source: 'pin', concrete: model.trim() };
  const alias = modelAliasOf(model);
  const mapped = alias ? settings.models[alias]?.trim() : undefined;
  if (mapped) return { selector: mapped, source: 'size', concrete: mapped };
  if (role) {
    const selector = ompRoleSelector(role, roles);
    if (selector) {
      const used = selector.slice(1);
      return { selector, source: 'role', role: used, concrete: roles?.[used]?.trim() || undefined };
    }
  }
  return { source: 'none' };
}

/** `--model` value: the OMP model configured for the tier, else the job's role, or undefined for OMP's default */
export function ompModelFor(model: string | undefined, settings: OmpBackendSettings, role?: string, roles?: OmpRoleMap): string | undefined {
  return resolveOmpSelection(model, settings, role, roles).selector;
}

/** Retries on the local model before giving up (or trying the fallback models): 0-10, default 5 */
export function ompMaxRetries(settings: Pick<OmpBackendSettings, 'retries'>): number {
  const n = settings.retries;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(0, Math.round(n)));
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
  allowFallback = false,
  /** Subagents a run may have at once (`task.maxConcurrency`); undefined leaves OMP's default (32) */
  subagents?: number,
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
  // Only the one final attempt of a task phase passes `allowFallback`; every other run stays on its model
  const fallbackPart = allowFallback ? '' : 'retry:\n  modelFallback: false\n';
  // OMP runs up to 32 subagents at once by default, far more than a local model server can serve;
  // 0 (the agent works alone) still needs a cap of 1 so a stray task call can't fan out
  const taskPart = subagents === undefined ? '' : `task:\n  maxConcurrency: ${Math.max(1, subagents)}\n`;
  return `${advisorPart}${fallbackPart}${taskPart}` || undefined;
}

/**
 * Config overlay for print mode (`omp -p`): the process ends with the agent, which kills a background bash job whose
 * result was to be injected later. With `async.enabled` off the bash tool has no `async` option and long commands are
 * not auto-backgrounded (verified omp 18.12.6: the `async` argument disappears from the tool).
 */
export const OMP_FOREGROUND_OVERLAY = 'async:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\n';

/** Appended to the system prompt of every run: a step must not end while a background job it depends on runs */
export const OMP_FOREGROUND_RULE = 'Run commands whose output you need in the foreground. Do not end your turn while a background job you depend on is still running.';

export interface OmpArgsOptions {
  settings: OmpBackendSettings;
  /** Workbench model tier or Claude model id */
  model?: string;
  /** OMP role used when `model` has no explicit OMP model (size mapping or pin) */
  role?: string;
  /** Roles the user's OMP config defines (undefined = not known yet) */
  roles?: OmpRoleMap;
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
  /** Config overlay file made from `OMP_FOREGROUND_OVERLAY` (`--config`): print mode cannot wait for background jobs */
  foregroundOverlayFile?: string;
  /** Files attached to the message (`@path`) */
  attachmentPaths?: readonly string[];
  /** Extension files loaded for this run (`-e`; they work with `--no-extensions` too) */
  extensionPaths?: readonly string[];
  /** `rpc`: `omp --mode rpc --no-ui` (prompt over stdin as a JSON command); default `print`: `omp -p --mode json` */
  transport?: 'print' | 'rpc';
}

export function buildOmpArgs(options: OmpArgsOptions): string[] {
  const { settings } = options;
  const args = options.transport === 'rpc' ? ['--mode', 'rpc', '--no-ui', '--no-title'] : ['-p', '--mode', 'json', '--no-title'];
  if (options.session) {
    args.push('--session-dir', options.session.dir);
    if (options.session.resume) args.push('--resume', options.session.resume);
  } else {
    args.push('--no-session');
  }
  const model = ompModelFor(options.model, settings, options.role, options.roles);
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
  for (const extension of options.extensionPaths ?? []) args.push('-e', extension);
  if (options.advisorMode === 'on') args.push('--advisor');
  if (options.advisorOverlayFile) args.push('--config', options.advisorOverlayFile);
  if (options.foregroundOverlayFile) args.push('--config', options.foregroundOverlayFile);
  if (settings.extraArgs?.length) args.push(...settings.extraArgs);
  if (options.attachmentPaths?.length) args.push(...options.attachmentPaths.map((p) => `@${p}`));
  return args;
}
