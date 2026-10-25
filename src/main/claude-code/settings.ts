import {
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_ALIASES,
  MAX_AI_REVIEW_ROUNDS,
  MIN_AI_REVIEW_ROUNDS,
  DEFAULT_CLAUDE_CODE_TASK_SETTINGS,
  type ClaudeCodeTaskSettings,
} from '../../shared/types/claude-code';

/** Complete task settings from the stored (partial) `AppSettings.claudeCodeTasks` */
export function resolveClaudeCodeTaskSettings(stored: Partial<ClaudeCodeTaskSettings> | undefined): ClaudeCodeTaskSettings {
  const merged = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, ...(stored ?? {}) };
  if (!CLAUDE_MODEL_ALIASES.includes(merged.fixedModel)) merged.fixedModel = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.fixedModel;
  if (!CLAUDE_MODEL_ALIASES.includes(merged.triageModel)) merged.triageModel = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.triageModel;
  if (!CLAUDE_EFFORTS.includes(merged.fixedEffort)) merged.fixedEffort = DEFAULT_CLAUDE_CODE_TASK_SETTINGS.fixedEffort;
  if (merged.triage !== 'auto' && merged.triage !== 'fixed') merged.triage = 'auto';
  if (!['auto', 'always', 'never'].includes(merged.planning)) merged.planning = 'auto';
  const rounds = Number(merged.aiReviewRounds);
  merged.aiReviewRounds = Number.isFinite(rounds)
    ? Math.min(MAX_AI_REVIEW_ROUNDS, Math.max(MIN_AI_REVIEW_ROUNDS, Math.round(rounds)))
    : DEFAULT_CLAUDE_CODE_TASK_SETTINGS.aiReviewRounds;
  return merged;
}
