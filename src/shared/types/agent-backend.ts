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

export const OMP_ADVISOR_MODES: readonly OmpAdvisorMode[] = ['inherit', 'on', 'off'] as const;

/** Settings for the OMP backend (Settings > Agents) */
export interface OmpBackendSettings {
  /** Path or command for the `omp` executable (default: `omp` on PATH) */
  command?: string;
  /**
   * OMP model for each Workbench model tier, passed as `omp --model` (e.g. `ollama/qwen3-coder:30b`,
   * `lmstudio/qwen2.5-coder-32b`). Empty means OMP's own default model role.
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
  /** OMP model for the advisor role (`modelRoles.advisor`); empty = the advisor model OMP is configured with */
  advisorModel?: string;
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
  advisorModel: '',
};

export const DEFAULT_AGENT_BACKEND_SETTINGS: AgentBackendSettings = {
  kind: 'claude',
  omp: DEFAULT_OMP_BACKEND_SETTINGS,
};
