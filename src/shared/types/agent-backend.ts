/**
 * Agent backend types
 *
 * Workbench runs its AI work through a local coding-agent CLI. The default backend is the
 * Claude Code CLI (`claude -p`). The OMP backend runs oh-my-pi (`omp -p --mode json`) instead,
 * which can drive local LLMs (Ollama, LM Studio, llama.cpp, MLX servers, any OpenAI-compatible
 * endpoint) configured in OMP's own `~/.omp/agent/models.yml`.
 */

import type { ClaudeEffort, ClaudeModelAlias } from './claude-code';

/** Which CLI runs tasks, triage, Insights and one-shot utility calls */
export type AgentBackendKind = 'claude' | 'omp';

export const AGENT_BACKEND_KINDS: readonly AgentBackendKind[] = ['claude', 'omp'] as const;

/** OMP thinking levels (`omp --thinking`) */
export type OmpThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/**
 * Whether OMP's advisor (a second model that reviews each turn and injects notes) runs:
 * `inherit` = whatever OMP's own config says, `on` = `--advisor`, `off` = disabled through a config overlay
 */
export type OmpAdvisorMode = 'inherit' | 'on' | 'off';
export type OmpAdvisorSchedule = 'continuous' | 'phase-boundaries' | 'off';

export const OMP_ADVISOR_MODES: readonly OmpAdvisorMode[] = ['inherit', 'on', 'off'] as const;

/** Settings for the OMP backend (Settings > Agents) */
export interface OmpBackendSettings {
  /** Path or command for the `omp` executable (default: `omp` on PATH) */
  command?: string;
  /**
   * Optional OMP model for each Workbench model tier, passed as `omp --model` (e.g. `ollama/qwen3-coder:30b`,
   * `lmstudio/qwen2.5-coder-32b`). A tier left empty uses the OMP role for the job: `plan` for planning,
   * `default` for implementing and utility calls, `judge` for the fresh-eyes review.
   * Triage picks a tier (haiku = small/fast ... fable = biggest); this maps the tier to a local model.
   */
  models: Partial<Record<ClaudeModelAlias, string>>;
  /** Thinking level for each Workbench effort level (`omp --thinking`) */
  thinking: Record<ClaudeEffort, OmpThinkingLevel>;
  /** Extra arguments added to every `omp` run (advanced) */
  extraArgs?: string[];
  /** Stop a task phase after this many minutes (`omp --max-time`); 0 or unset = no limit */
  maxPhaseMinutes?: number;
  /** Advisor for task phases, Insights and agent terminals (utility calls never use it); default `inherit` */
  advisor?: OmpAdvisorMode;
  /** Task-only schedule. Insights and agent terminals retain their configured advisor mode. */
  advisorSchedule?: OmpAdvisorSchedule;
  /** OMP model for the advisor role (`modelRoles.advisor`); empty = the advisor model OMP is configured with */
  advisorModel?: string;
  /**
   * After the retries on the local model fail, try a task phase once more letting OMP switch to the
   * fallback models of its config (`retry.fallbackChains`). Off by default so local runs stay local and
   * do not use cloud quota.
   */
  allowFallbackModels?: boolean;
  /** Retries of a task phase on the local model before giving up or trying the fallback models; 0-10, default 5 */
  retries?: number;
  /**
   * Subagents one task may run at once through OMP's `task` tool (`task.maxConcurrency`), so a
   * single ticket can use several model-server slots. 0 = the agent works alone; 0-8, default 3
   */
  subagentsPerTask?: number;
  /**
   * Task phases with messaging run through `omp --mode rpc`, so messages from other tasks reach the
   * running step at its next turn; off = `omp -p` and messages wait for the next step. Default true
   */
  liveMessages?: boolean;
}

/** Subagent concurrency for one task: the setting clamped to 0-8, default 3 */
export function ompSubagentsPerTask(settings: Pick<OmpBackendSettings, 'subagentsPerTask'>): number {
  const value = Math.round(Number(settings.subagentsPerTask ?? 3));
  return Number.isFinite(value) ? Math.min(8, Math.max(0, value)) : 3;
}

export interface AgentBackendSettings {
  kind: AgentBackendKind;
  omp: OmpBackendSettings;
}

export const DEFAULT_OMP_BACKEND_SETTINGS: OmpBackendSettings = {
  command: 'omp',
  models: {},
  thinking: { low: 'off', medium: 'low', high: 'medium', xhigh: 'high', max: 'high' },
  extraArgs: [],
  maxPhaseMinutes: 0,
  advisor: 'inherit',
  advisorSchedule: 'phase-boundaries',
  advisorModel: '',
  allowFallbackModels: false,
  retries: 5,
  subagentsPerTask: 3,
  liveMessages: true,
};

export const DEFAULT_AGENT_BACKEND_SETTINGS: AgentBackendSettings = {
  kind: 'claude',
  omp: DEFAULT_OMP_BACKEND_SETTINGS,
};
