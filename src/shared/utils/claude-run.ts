/**
 * Helpers for showing a task's Claude Code run (triage, steps, cost) in the UI.
 */
import type { ClaudeRunInfo, ClaudeRunPhaseName } from '../types/claude-code';
import type { ExecutionPhase } from '../types/task';

/**
 * What a running task is doing, as a `tasks:execution.steps.*` key:
 * the planning phase covers both triage ("assessing") and Claude Code plan mode ("planning").
 */
export type TaskRunStep =
  | 'idle'
  | 'assessing'
  | 'planning'
  | 'implementing'
  | 'revising'
  | 'validating'
  | 'fixing'
  | 'rate_limit_paused'
  | 'auth_failure_paused'
  | 'complete'
  | 'failed';

const STEP_BY_RUN_PHASE: Record<ClaudeRunPhaseName, TaskRunStep> = {
  triage: 'assessing',
  plan: 'planning',
  implement: 'implementing',
  revise: 'revising',
  validate: 'validating'
};

/** Which run steps belong to each execution phase */
const RUN_PHASES_BY_EXECUTION_PHASE: Partial<Record<ExecutionPhase, ClaudeRunPhaseName[]>> = {
  planning: ['triage', 'plan'],
  coding: ['implement', 'revise'],
  qa_review: ['validate']
};

/**
 * The step a task is in, from its execution phase and (when it agrees with the phase)
 * the last step recorded in its Claude Code run.
 */
export function getTaskRunStep(
  phase: ExecutionPhase | undefined,
  run?: Pick<ClaudeRunInfo, 'phases'>,
  message?: string
): TaskRunStep {
  if (!phase) return 'idle';
  const lastRunPhase = run?.phases?.[run.phases.length - 1]?.name;
  const candidates = RUN_PHASES_BY_EXECUTION_PHASE[phase];
  if (candidates && lastRunPhase && candidates.includes(lastRunPhase)) {
    return STEP_BY_RUN_PHASE[lastRunPhase];
  }
  switch (phase) {
    case 'planning':
      return message && /plan/i.test(message) ? 'planning' : 'assessing';
    case 'coding':
      return 'implementing';
    case 'qa_review':
      return 'validating';
    case 'qa_fixing':
      return 'fixing';
    default:
      return phase;
  }
}

/** USD with 2 decimals, or up to 4 for amounts under a dollar ("$0.0123") */
export function formatCostUsd(usd: number): string {
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(usd) < 1 ? 4 : 2
  });
}

/** Compact duration: "850ms", "42s", "3m 05s", "1h 02m" */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Shell command that reopens the task's Claude Code session in its worktree */
export function buildResumeCommand(sessionId: string, worktreePath?: string): string {
  const resume = `claude --resume ${sessionId}`;
  return worktreePath ? `cd "${worktreePath}" && ${resume}` : resume;
}
