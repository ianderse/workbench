/**
 * Helpers for showing a task's Claude Code run (triage, steps, cost) in the UI, and for opening
 * its session in an agent window.
 */
import type { ClaudeRunInfo, ClaudeRunPhase, ClaudeRunPhaseName } from '../types/claude-code';
import type { ExecutionPhase, Task } from '../types/task';

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

/** How long a run step took: its reported duration, or the time between its start and end */
export function getRunPhaseDurationMs(phase: ClaudeRunPhase): number | undefined {
  if (phase.durationMs !== undefined) return phase.durationMs;
  if (!phase.endedAt) return undefined;
  const ms = new Date(phase.endedAt).getTime() - new Date(phase.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** Log sections of a task (Logs tab) */
export type TaskLogPhase = 'planning' | 'coding' | 'validation';

/** Which run steps each log section covers */
const RUN_PHASES_BY_LOG_PHASE: Record<TaskLogPhase, ClaudeRunPhaseName[]> = {
  planning: ['triage', 'plan'],
  coding: ['implement', 'revise'],
  validation: ['validate']
};

/**
 * Total duration and cost of the run steps in a log section (triage + plan for planning,
 * implement + revise for coding, validate for validation). A field is left out when none of
 * the section's steps reported it.
 */
export function summarizeLogPhase(
  phases: ClaudeRunPhase[] | undefined,
  logPhase: TaskLogPhase
): { durationMs?: number; costUsd?: number } {
  const names = RUN_PHASES_BY_LOG_PHASE[logPhase];
  let durationMs: number | undefined;
  let costUsd: number | undefined;
  for (const phase of phases ?? []) {
    if (!names.includes(phase.name)) continue;
    const duration = getRunPhaseDurationMs(phase);
    if (duration !== undefined) durationMs = (durationMs ?? 0) + duration;
    if (phase.costUsd !== undefined) costUsd = (costUsd ?? 0) + phase.costUsd;
  }
  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {})
  };
}

/**
 * Why a task's Claude Code session cannot be opened in an agent window, or null when it can:
 * there is no session yet, or the task is running (another process is writing to the session)
 */
export function getTaskSessionBlocker(
  task: Pick<Task, 'status' | 'claudeRun'>
): 'noSession' | 'running' | null {
  if (!task.claudeRun?.sessionId) return 'noSession';
  if (task.status === 'in_progress') return 'running';
  return null;
}

/** Git branch of a task's worktree (`<project>/.auto-claude/worktrees/tasks/<specId>`) */
export function getTaskWorktreeBranch(specId: string): string {
  return `auto-claude/${specId}`;
}
