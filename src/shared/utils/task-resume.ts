/**
 * Which tasks can be resumed: stopped or failed before their run went all the way through.
 * Resume continues the task's own worktree and Claude Code / OMP session at the last unfinished
 * step (see `ClaudeTaskRun.runSteps`); Start over is the destructive alternative.
 */
import type { Task } from '../types/task';
import type { ClaudeRunInfo } from '../types/claude-code';

function hasPendingRevision(run: ClaudeRunInfo | undefined | null): boolean {
  return !!(run?.revisionRequest && !run.revisionRequest.settledAt && !run.revisionRequest.supersededAt);
}

/**
 * Whether the run went all the way through: its last step is a finished validation, or a finished
 * implementation/revision when validation is off (same rule as the main process's
 * `isClaudeRunFinished`). An unsettled revision request still has work to continue even if
 * the last recorded phase belongs to the earlier completed run or ended between phases.
 * A finished run has nothing left to resume.
 */
export function isRunFinished(run: ClaudeRunInfo | undefined | null, validation = true): boolean {
  if (hasPendingRevision(run)) return false;
  const last = run?.phases.at(-1);
  if (!last?.endedAt || last.isError) return false;
  if (last.name === 'validate' || last.name === 'spec_review') return true;
  return !validation && (last.name === 'implement' || last.name === 'revise');
}

/**
 * A task that is not running, was stopped (Human Review, reason `stopped`), waits for a proposed split
 * (reason `split_proposed`; resuming continues with whatever was decided) or failed (Error, or
 * Human Review with reason `errors`) and whose run still has an unfinished step. A rejected
 * review can retain its reason while a later attempt is interrupted; resume that unfinished
 * attempt, but do not reopen a completed review or a review with no recorded run.
 */
export function canResumeTask(task: Task, validation = true): boolean {
  if (task.metadata?.archivedAt) return false;
  const stoppedOrFailed =
    task.status === 'error'
    || (task.status === 'human_review' && (
      task.reviewReason === 'stopped'
      || task.reviewReason === 'errors'
      || task.reviewReason === 'split_proposed'
      || (task.reviewReason === 'qa_rejected' && (
        !!task.claudeRun?.phases.length
        || hasPendingRevision(task.claudeRun)
      ))
    ));
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

/**
 * Why a task in Human Review did not finish: `stopped` (the user pressed Stop) or `interrupted`
 * (the run died or ended early without a finished last step). Null for a finished run and for
 * reviews with their own label (auto-merged, split proposed, errors).
 */
export function reviewInterruption(task: Task, validation = true): 'stopped' | 'interrupted' | null {
  if (task.status !== 'human_review') return null;
  if (task.reviewReason === 'stopped') return 'stopped';
  if (task.reviewReason === 'auto_merged' || task.reviewReason === 'split_proposed' || task.reviewReason === 'errors') return null;
  if ((task.claudeRun?.phases.length || hasPendingRevision(task.claudeRun)) && !isRunFinished(task.claudeRun, validation)) return 'interrupted';
  // Same rule as the task store's isIncompleteHumanReview: no reason and no subtask completed
  if (!task.reviewReason && !task.subtasks?.some((s) => s.status === 'completed')) return 'interrupted';
  return null;
}
