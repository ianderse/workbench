/**
 * Per-task agent override: which backend, model and effort a task runs with.
 * Pure helpers shared by the main process (runner, auth check) and the renderer (task card, dialog).
 */

import type { AgentBackendKind } from '../types/agent-backend';
import type { ClaudeEffort } from '../types/claude-code';
import { CLAUDE_EFFORTS } from '../types/claude-code';
import type { AgentOverride } from '../types/task';

export interface EffectiveAgent {
  backend: AgentBackendKind;
  /** Pinned model (alias or exact id), undefined = triage / settings decide */
  model?: string;
  /** Pinned effort, undefined = triage / settings decide */
  effort?: ClaudeEffort;
  /** The task's backend differs from the app's */
  backendPinned: boolean;
}

/** Backend, model and effort a task runs with, from its override and the app-wide backend */
export function resolveEffectiveAgent(
  override: AgentOverride | undefined,
  appBackend: AgentBackendKind,
): EffectiveAgent {
  const backend = override?.backend === 'claude' || override?.backend === 'omp' ? override.backend : appBackend;
  const model = override?.model?.trim() || undefined;
  const effort = override?.effort && (CLAUDE_EFFORTS as readonly string[]).includes(override.effort) ? override.effort : undefined;
  return { backend, model, effort, backendPinned: !!override?.backend && override.backend !== appBackend };
}

/** An override with nothing set is stored as no override */
export function normalizeAgentOverride(override: AgentOverride | undefined): AgentOverride | undefined {
  if (!override) return undefined;
  const out: AgentOverride = {};
  if (override.backend) out.backend = override.backend;
  if (override.model?.trim()) out.model = override.model.trim();
  if (override.effort) out.effort = override.effort;
  return Object.keys(out).length > 0 ? out : undefined;
}
