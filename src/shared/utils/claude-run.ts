/**
 * Helpers for showing a task's Claude Code run (triage, steps, cost) in the UI, and for opening
 * its session in an agent window.
 */
import type { ClaudeRunPhase, ClaudeRunPhaseName } from '../types/claude-code';
import type { Task } from '../types/task';

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
  validation: ['review', 'validate']
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
 * Why a task's Claude Code session cannot be opened in an agent window, or null when it can
 * (there is no session yet). A running task's session opens read-only: the window follows it
 * and resumes it once the task stops.
 */
export function getTaskSessionBlocker(task: Pick<Task, 'claudeRun'>): 'noSession' | null {
  return task.claudeRun?.sessionId ? null : 'noSession';
}

/** Whether a task's run is writing to its session (implementing or validating) */
export function isTaskSessionActive(task: Pick<Task, 'status'>): boolean {
  return task.status === 'in_progress' || task.status === 'ai_review';
}

/** Git branch of a task's worktree (`<project>/.workbench/worktrees/tasks/<specId>`) */
export function getTaskWorktreeBranch(specId: string): string {
  return `workbench/${specId}`;
}
