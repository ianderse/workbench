/**
 * Labels for a task's pinned model, shared by the model picker, the task card and the task detail.
 */

import { CLAUDE_MODEL_ALIASES, type ClaudeModelAlias } from '../types/claude-code';
import type { AgentBackendKind, OmpBackendSettings } from '../types/agent-backend';
import type { AgentOverride } from '../types/task';

/** Claude Code tier aliases with the current model each one stands for (shown in the task model picker) */
export const CLAUDE_TASK_MODEL_LABELS: Record<ClaudeModelAlias, string> = {
  opus: 'Opus 5.5',
  sonnet: 'Sonnet 5.5',
  haiku: 'Haiku 5.5',
  fable: 'Fable 5.1',
};

export function isModelAlias(model: string | undefined): model is ClaudeModelAlias {
  return !!model && (CLAUDE_MODEL_ALIASES as readonly string[]).includes(model);
}

/** "omlx/Qwen3.8-27B-oQ8e-mtp" -> "Qwen3.8-27B-oQ8e-mtp" */
export function shortOmpModel(model: string): string {
  return model.slice(model.indexOf('/') + 1);
}

/** Short label of a pinned model, or undefined when no model is pinned. OMP ones read "OMP · name" */
export function pinnedModelLabel(
  override: AgentOverride | undefined,
  appBackend: AgentBackendKind,
  ompModels?: OmpBackendSettings['models'],
): string | undefined {
  const model = override?.model?.trim();
  if (!model) return undefined;
  const backend = override?.backend ?? appBackend;
  if (backend === 'omp') {
    const mapped = isModelAlias(model) ? ompModels?.[model]?.trim() : model;
    return `OMP · ${mapped ? shortOmpModel(mapped) : model}`;
  }
  return isModelAlias(model) ? CLAUDE_TASK_MODEL_LABELS[model] : model;
}
