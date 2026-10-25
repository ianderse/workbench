/**
 * Which tasks can be resumed: stopped or failed before their run went all the way through.
 * Resume continues the task's own worktree and Claude Code / OMP session at the last unfinished
 * step (see `ClaudeTaskRun.runSteps`); Start over is the destructive alternative.
 */
import type { Task } from '../types/task';
import type { ClaudeRunInfo } from '../types/claude-code';

/**
 * Whether the run went all the way through: its last step is a finished validation, or a finished
 * implementation/revision when validation is off (same rule as the main process's
 * `isClaudeRunFinished`). A finished run has nothing left to resume.
 */
export function isRunFinished(run: ClaudeRunInfo | undefined | null, validation = true): boolean {
  const last = run?.phases.at(-1);
  if (!last?.endedAt || last.isError) return false;
  if (last.name === 'validate' || last.name === 'spec_review') return true;
  return !validation && (last.name === 'implement' || last.name === 'revise');
}

/**
 * A task that is not running, was stopped (Human Review, reason `stopped`), waits for a proposed split
 * (reason `split_proposed`; resuming continues with whatever was decided) or failed (Error, or
 * Human Review with reason `errors`) and whose run still has an unfinished step.
 */
export function canResumeTask(task: Task, validation = true): boolean {
  if (task.metadata?.archivedAt) return false;
  const stoppedOrFailed =
    task.status === 'error'
    || (task.status === 'human_review' && (task.reviewReason === 'stopped' || task.reviewReason === 'errors' || task.reviewReason === 'split_proposed'));
  if (!stoppedOrFailed) return false;
  return !isRunFinished(task.claudeRun, validation);
}

/**
 * What to do at startup with a task the last app session left running (its run died with the app):
 * resume an unfinished run, move a finished one to review, or leave it (not left running, archived,
 * or actually running).
 */
export function stuckTaskStartupAction(
  task: Pick<Task, 'status' | 'metadata'>,
  run: ClaudeRunInfo | undefined | null,
  isRunning: boolean,
  validation = true
): 'resume' | 'review' | null {
  if (task.metadata?.archivedAt || isRunning) return null;
  if (task.status !== 'in_progress' && task.status !== 'ai_review') return null;
  return isRunFinished(run, validation) ? 'review' : 'resume';
}
