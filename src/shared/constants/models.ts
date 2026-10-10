/**
 * Model and agent profile constants
 * Claude models, thinking levels, memory backends, and agent profiles
 */

import type { AgentProfile, PhaseModelConfig } from '../types/settings';
import type { BuiltinProvider } from '../types/provider-account';

// ============================================
// Available Models
// ============================================

export const AVAILABLE_MODELS = [
  { value: 'opus', label: 'Claude Opus 4.6' },
  { value: 'opus-1m', label: 'Claude Opus 4.6 (1M)' },
  { value: 'opus-4.5', label: 'Claude Opus 4.5' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6' },
  { value: 'haiku', label: 'Claude Haiku 4.5' }
] as const;

// ============================================
// Multi-Provider Model Catalog
// ============================================

export interface ModelOption {
  value: string;
  label: string;
  provider: BuiltinProvider;
  description?: string;
  apiKeyOnly?: boolean;
  capabilities?: {
    thinking: boolean;
    tools: boolean;
    vision: boolean;
    contextWindow: number;
  };
}

export const ALL_AVAILABLE_MODELS: ModelOption[] = [
  // Anthropic
  { value: 'opus', label: 'Claude Opus 4.6', provider: 'anthropic', description: 'Most capable', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 200000 } },
  { value: 'opus-1m', label: 'Claude Opus 4.6 (1M)', provider: 'anthropic', description: '1M context', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 1000000 } },
  { value: 'sonnet', label: 'Claude Sonnet 4.6', provider: 'anthropic', description: 'Balanced', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 200000 } },
  { value: 'opus-4.5', label: 'Claude Opus 4.5', provider: 'anthropic', description: 'Legacy', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 200000 } },
  { value: 'haiku', label: 'Claude Haiku 4.5', provider: 'anthropic', description: 'Fast', capabilities: { thinking: false, tools: true, vision: true, contextWindow: 200000 } },
  // OpenAI
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai', description: 'Agentic coding', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 1047576 } },
  { value: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai', description: 'Flagship', apiKeyOnly: true, capabilities: { thinking: true, tools: true, vision: true, contextWindow: 400000 } },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', provider: 'openai', description: 'Coding', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 1047576 } },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', provider: 'openai', description: 'Fast coding', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 400000 } },
  { value: 'gpt-5-nano', label: 'GPT-5 Nano', provider: 'openai', description: 'Fastest & cheapest', apiKeyOnly: true, capabilities: { thinking: false, tools: true, vision: true, contextWindow: 400000 } },
  { value: 'o3', label: 'o3', provider: 'openai', description: 'Reasoning', apiKeyOnly: true, capabilities: { thinking: true, tools: true, vision: true, contextWindow: 200000 } },
  { value: 'o4-mini', label: 'o4 Mini', provider: 'openai', description: 'Fast reasoning', apiKeyOnly: true, capabilities: { thinking: true, tools: true, vision: true, contextWindow: 200000 } },
  // Google
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', description: 'Advanced', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 1048576 } },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', description: 'Fast thinking', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 1048576 } },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', provider: 'google', description: 'Budget', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 1048576 } },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', provider: 'google', description: 'Legacy', capabilities: { thinking: false, tools: true, vision: true, contextWindow: 1048576 } },
  // Mistral
  { value: 'mistral-large-latest', label: 'Mistral Large', provider: 'mistral', description: 'Flagship', capabilities: { thinking: false, tools: true, vision: true, contextWindow: 128000 } },
  { value: 'mistral-small-latest', label: 'Mistral Small', provider: 'mistral', description: 'Fast', capabilities: { thinking: false, tools: true, vision: true, contextWindow: 128000 } },
  // Groq
  { value: 'meta-llama/llama-4-maverick', label: 'LLaMA 4 Maverick', provider: 'groq', description: 'Multimodal', capabilities: { thinking: false, tools: true, vision: true, contextWindow: 128000 } },
  { value: 'llama-3.3-70b-versatile', label: 'LLaMA 3.3 70B', provider: 'groq', description: 'Fast inference', capabilities: { thinking: false, tools: true, vision: false, contextWindow: 128000 } },
  // xAI
  { value: 'grok-4-0709', label: 'Grok 4', provider: 'xai', description: 'Flagship', capabilities: { thinking: true, tools: true, vision: true, contextWindow: 256000 } },
  { value: 'grok-3', label: 'Grok 3', provider: 'xai', description: 'Text', capabilities: { thinking: false, tools: true, vision: false, contextWindow: 131072 } },
  { value: 'grok-3-mini', label: 'Grok 3 Mini', provider: 'xai', description: 'Fast reasoning', capabilities: { thinking: true, tools: true, vision: false, contextWindow: 131072 } },
  // Z.AI (Zhipu)
  { value: 'glm-5', label: 'GLM-5', provider: 'zai', description: 'Flagship', capabilities: { thinking: false, tools: true, vision: false, contextWindow: 128000 } },
  { value: 'glm-4.7', label: 'GLM-4.7', provider: 'zai', description: 'Previous flagship', capabilities: { thinking: false, tools: true, vision: false, contextWindow: 128000 } },
  { value: 'glm-4.6v', label: 'GLM-4.6V', provider: 'zai', description: 'Multimodal', capabilities: { thinking: false, tools: true, vision: true, contextWindow: 128000 } },
  { value: 'glm-4.5-flash', label: 'GLM-4.5 Flash', provider: 'zai', description: 'Fast', capabilities: { thinking: false, tools: true, vision: false, contextWindow: 128000 } },
];

// ============================================
// Thinking Levels
// ============================================

// Thinking levels for Claude model (budget token allocation)
export const THINKING_LEVELS = [
  { value: 'low', label: 'Low', description: 'Brief consideration' },
  { value: 'medium', label: 'Medium', description: 'Moderate analysis' },
  { value: 'high', label: 'High', description: 'Deep thinking' },
  { value: 'xhigh', label: 'Extra High', description: 'Maximum reasoning' }
] as const;

// ============================================
// Agent Profiles - Phase Configurations
// ============================================

// Phase configurations for each preset profile
// Each profile has its own default phase models and thinking levels

// Auto (Optimized) - Opus with optimized thinking per phase
export const AUTO_PHASE_MODELS: PhaseModelConfig = {
  spec: 'opus',
  planning: 'opus',
  coding: 'opus',
  qa: 'opus'
};

export const AUTO_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'high',   // Deep thinking for comprehensive spec creation
  planning: 'high',     // High thinking for planning complex features
  coding: 'low',        // Faster coding iterations
  qa: 'low'             // Efficient QA review
};

// Complex Tasks - Opus with high thinking across all phases
export const COMPLEX_PHASE_MODELS: PhaseModelConfig = {
  spec: 'opus',
  planning: 'opus',
  coding: 'opus',
  qa: 'opus'
};

export const COMPLEX_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'high',
  planning: 'high',
  coding: 'high',
  qa: 'high'
};

// Balanced - Sonnet with medium thinking across all phases
export const BALANCED_PHASE_MODELS: PhaseModelConfig = {
  spec: 'sonnet',
  planning: 'sonnet',
  coding: 'sonnet',
  qa: 'sonnet'
};

export const BALANCED_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'medium',
  planning: 'medium',
  coding: 'medium',
  qa: 'medium'
};

// Quick Edits - Haiku with low thinking across all phases
export const QUICK_PHASE_MODELS: PhaseModelConfig = {
  spec: 'haiku',
  planning: 'haiku',
  coding: 'haiku',
  qa: 'haiku'
};

export const QUICK_PHASE_THINKING: import('../types/settings').PhaseThinkingConfig = {
  spec: 'low',
  planning: 'low',
  coding: 'low',
  qa: 'low'
};

// Default agent profiles for preset model/thinking configurations
// All profiles have per-phase configuration for full customization
export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'auto',
    name: 'Auto (Optimized)',
    description: 'Uses Opus across all phases with optimized thinking levels',
    model: 'opus',
    thinkingLevel: 'high',
    icon: 'Sparkles',
    phaseModels: AUTO_PHASE_MODELS,
    phaseThinking: AUTO_PHASE_THINKING
  },
  {
    id: 'complex',
    name: 'Complex Tasks',
    description: 'For intricate, multi-step implementations requiring deep analysis',
    model: 'opus',
    thinkingLevel: 'high',
    icon: 'Brain',
    phaseModels: COMPLEX_PHASE_MODELS,
    phaseThinking: COMPLEX_PHASE_THINKING
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Good balance of speed and quality for most tasks',
    model: 'sonnet',
    thinkingLevel: 'medium',
    icon: 'Scale',
    phaseModels: BALANCED_PHASE_MODELS,
    phaseThinking: BALANCED_PHASE_THINKING
  },
  {
    id: 'quick',
    name: 'Quick Edits',
    description: 'Fast iterations for simple changes and quick fixes',
    model: 'haiku',
    thinkingLevel: 'low',
    icon: 'Zap',
    phaseModels: QUICK_PHASE_MODELS,
    phaseThinking: QUICK_PHASE_THINKING
  },
];

// Valid thinking levels for validation
export const VALID_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;

// Legacy thinking level mappings (must match backend phase_config.py LEGACY_THINKING_LEVEL_MAP)
export const LEGACY_THINKING_MAP: Record<string, string> = { ultrathink: 'high', none: 'low' } as const;

/** Sanitize a thinking level value, mapping legacy values to valid ones */
export function sanitizeThinkingLevel(val: string): string {
  if (VALID_THINKING_LEVELS.includes(val as typeof VALID_THINKING_LEVELS[number])) return val;
  return LEGACY_THINKING_MAP[val] ?? 'medium';
}

// ============================================
// Reasoning Configuration Types
// ============================================

export type ReasoningType =
  | 'thinking_tokens'     // Anthropic: budget-based thinking
  | 'adaptive_effort'     // Anthropic Opus 4.6: effort level + budget cap
  | 'reasoning_effort'    // OpenAI o-series: reasoning_effort param
  | 'thinking_toggle'     // Google: thinking enabled/disabled
  | 'none';               // No reasoning/thinking API

export interface ReasoningConfig {
  type: ReasoningType;
  level?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface ProviderModelSpec {
  modelId: string;
  reasoning: ReasoningConfig;
}

export const DEFAULT_MODEL_EQUIVALENCES: Record<string, Partial<Record<BuiltinProvider, ProviderModelSpec>>> = {
  // ── Anthropic shorthands ──────────────────────────────────────────────────
  'opus': {
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    openai: { modelId: 'gpt-5.3-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
    xai: { modelId: 'grok-4-0709', reasoning: { type: 'reasoning_effort', level: 'high' } },
    mistral: { modelId: 'mistral-large-latest', reasoning: { type: 'none' } },
    groq: { modelId: 'meta-llama/llama-4-maverick', reasoning: { type: 'none' } },
    zai: { modelId: 'glm-5', reasoning: { type: 'none' } },
  },
  'glm-5': {
    zai: { modelId: 'glm-5', reasoning: { type: 'none' } },
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    openai: { modelId: 'gpt-5.3-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
  },
  'glm-4.7': {
    zai: { modelId: 'glm-4.7', reasoning: { type: 'none' } },
    anthropic: { modelId: 'claude-sonnet-4-6', reasoning: { type: 'thinking_tokens', level: 'medium' } },
    openai: { modelId: 'gpt-5.2', reasoning: { type: 'reasoning_effort', level: 'medium' } },
  },
  'opus-1m': {
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    openai: { modelId: 'gpt-5.2', reasoning: { type: 'reasoning_effort', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
  },
  'opus-4.5': {
    anthropic: { modelId: 'claude-opus-4-5-20251101', reasoning: { type: 'thinking_tokens', level: 'high' } },
    openai: { modelId: 'gpt-5.3-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
  },
  'sonnet': {
    anthropic: { modelId: 'claude-sonnet-4-6', reasoning: { type: 'thinking_tokens', level: 'medium' } },
    openai: { modelId: 'gpt-5.2-codex', reasoning: { type: 'reasoning_effort', level: 'medium' } },
    google: { modelId: 'gemini-2.5-flash', reasoning: { type: 'thinking_toggle', level: 'medium' } },
    mistral: { modelId: 'mistral-large-latest', reasoning: { type: 'none' } },
    groq: { modelId: 'llama-3.3-70b-versatile', reasoning: { type: 'none' } },
    xai: { modelId: 'grok-3-mini', reasoning: { type: 'reasoning_effort', level: 'medium' } },
    zai: { modelId: 'glm-4.7', reasoning: { type: 'none' } },
  },
  'haiku': {
    anthropic: { modelId: 'claude-haiku-4-5-20251001', reasoning: { type: 'none' } },
    openai: { modelId: 'gpt-5.1-codex-mini', reasoning: { type: 'reasoning_effort', level: 'low' } },
    google: { modelId: 'gemini-2.5-flash-lite', reasoning: { type: 'thinking_toggle', level: 'low' } },
    mistral: { modelId: 'mistral-small-latest', reasoning: { type: 'none' } },
    groq: { modelId: 'llama-3.3-70b-versatile', reasoning: { type: 'none' } },
    zai: { modelId: 'glm-4.5-flash', reasoning: { type: 'none' } },
  },
  // ── OpenAI models ─────────────────────────────────────────────────────────
  'gpt-5.3-codex': {
    openai: { modelId: 'gpt-5.3-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
  },
  'gpt-5.2': {
    openai: { modelId: 'gpt-5.2', reasoning: { type: 'reasoning_effort', level: 'high' } },
    anthropic: { modelId: 'claude-sonnet-4-6', reasoning: { type: 'thinking_tokens', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
  },
  'gpt-5.2-codex': {
    openai: { modelId: 'gpt-5.2-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
  },
  'gpt-5.1-codex-mini': {
    openai: { modelId: 'gpt-5.1-codex-mini', reasoning: { type: 'reasoning_effort', level: 'low' } },
    anthropic: { modelId: 'claude-haiku-4-5-20251001', reasoning: { type: 'none' } },
    google: { modelId: 'gemini-2.5-flash-lite', reasoning: { type: 'thinking_toggle', level: 'low' } },
  },
  'gpt-5-nano': {
    openai: { modelId: 'gpt-5-nano', reasoning: { type: 'none' } },
    anthropic: { modelId: 'claude-haiku-4-5-20251001', reasoning: { type: 'none' } },
    google: { modelId: 'gemini-2.5-flash-lite', reasoning: { type: 'thinking_toggle', level: 'low' } },
  },
  'o3': {
    openai: { modelId: 'o3', reasoning: { type: 'reasoning_effort', level: 'high' } },
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
  },
  'o4-mini': {
    openai: { modelId: 'o4-mini', reasoning: { type: 'reasoning_effort', level: 'medium' } },
    anthropic: { modelId: 'claude-sonnet-4-6', reasoning: { type: 'thinking_tokens', level: 'medium' } },
    google: { modelId: 'gemini-2.5-flash', reasoning: { type: 'thinking_toggle', level: 'medium' } },
  },
  // ── Google models ─────────────────────────────────────────────────────────
  'gemini-2.5-pro': {
    google: { modelId: 'gemini-2.5-pro', reasoning: { type: 'thinking_toggle', level: 'high' } },
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    openai: { modelId: 'gpt-5.3-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
  },
  'gemini-2.5-flash': {
    google: { modelId: 'gemini-2.5-flash', reasoning: { type: 'thinking_toggle', level: 'medium' } },
    anthropic: { modelId: 'claude-sonnet-4-6', reasoning: { type: 'thinking_tokens', level: 'medium' } },
    openai: { modelId: 'gpt-5.2', reasoning: { type: 'reasoning_effort', level: 'medium' } },
  },
  // ── xAI models ────────────────────────────────────────────────────────────
  'grok-4-0709': {
    xai: { modelId: 'grok-4-0709', reasoning: { type: 'reasoning_effort', level: 'high' } },
    anthropic: { modelId: 'claude-opus-4-6', reasoning: { type: 'adaptive_effort', level: 'high' } },
    openai: { modelId: 'gpt-5.3-codex', reasoning: { type: 'reasoning_effort', level: 'high' } },
  },
  'grok-3-mini': {
    xai: { modelId: 'grok-3-mini', reasoning: { type: 'reasoning_effort', level: 'medium' } },
    anthropic: { modelId: 'claude-sonnet-4-6', reasoning: { type: 'thinking_tokens', level: 'medium' } },
    openai: { modelId: 'o4-mini', reasoning: { type: 'reasoning_effort', level: 'medium' } },
  },
};

export function resolveModelEquivalent(
  modelValue: string,
  targetProvider: BuiltinProvider,
  userOverrides?: Record<string, Partial<Record<BuiltinProvider, ProviderModelSpec>>>
): ProviderModelSpec | null {
  const override = userOverrides?.[modelValue]?.[targetProvider];
  if (override) return override;

  // Direct lookup by shorthand or full ID
  const direct = DEFAULT_MODEL_EQUIVALENCES[modelValue]?.[targetProvider];
  if (direct) return direct;

  // Reverse lookup: if modelValue is a full model ID (e.g. 'claude-opus-4-6'),
  // find which equivalence entry resolves to that ID and use the target provider mapping
  for (const [_key, providerMap] of Object.entries(DEFAULT_MODEL_EQUIVALENCES)) {
    for (const spec of Object.values(providerMap)) {
      if (spec?.modelId === modelValue) {
        const targetSpec = providerMap[targetProvider];
        if (targetSpec) return targetSpec;
      }
    }
  }

  return null;
}
