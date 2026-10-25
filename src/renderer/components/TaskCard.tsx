import { useState, useEffect, useRef, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Play, Square, Loader2, RotateCcw, Archive, GitPullRequest, MoreVertical, ClipboardCheck } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn, formatRelativeTime, sanitizeMarkdownForDisplay } from '../lib/utils';
import {
  TASK_STATUS_LABELS,
  getAllowedTaskMoves,
  JSON_ERROR_PREFIX,
  JSON_ERROR_TITLE_SUFFIX
} from '../../shared/constants';
import { stopTask, checkTaskRunning, isIncompleteHumanReview, archiveTasks, hasRecentActivity, startTaskOrQueue, taskHasErrors, retryTask, recoverStuckTask, useTaskStore, unmetDependencyTitles } from '../stores/task-store';
import type { Task, TaskStatus } from '../../shared/types';
import { useSettingsStore } from '../stores/settings-store';
import { useProjectStore } from '../stores/project-store';
import { activeAutoMerge } from '../../shared/utils/autonomous';
import { taskNumber } from '../../shared/utils/queue-grooming';
import { pinnedModelLabel } from '../../shared/utils/agent-override-labels';
import { canResumeTask, isRunFinished } from '../../shared/utils/task-resume';
import { StartOverDialog } from './StartOverDialog';

// Stuck detection interval (ms). XState handles normal process exits (PROCESS_EXITED); this
// catches a task left In Progress or AI Review without a run (e.g. the app quit mid-run),
// checked when the card mounts and then every 60 seconds.
const STUCK_CHECK_INTERVAL_MS = 60_000;
/**
 * While a card shows Stuck, look again often: the app resumes stuck tasks a few seconds after it
 * starts, and a resumed task keeps its status, so nothing else tells the card it runs again
 */
const STUCK_RECHECK_MS = 3_000;

// Icon-only buttons, like the settings dialog's (muted icon, nav hover background)
const ICON_BUTTON_CLASS = 'h-8 w-8 rounded-lg p-0 text-muted-foreground hover:bg-nav-hover hover:text-foreground';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange?: (newStatus: TaskStatus) => unknown;
}

// Custom comparator for React.memo - only re-render when relevant task data changes
function taskCardPropsAreEqual(prevProps: TaskCardProps, nextProps: TaskCardProps): boolean {
  const prevTask = prevProps.task;
  const nextTask = nextProps.task;

  // Fast path: same reference
  if (
    prevTask === nextTask &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.onStatusChange === nextProps.onStatusChange
  ) {
    return true;
  }

  // Compare only the fields that affect rendering
  const isEqual = (
    prevTask.id === nextTask.id &&
    prevTask.status === nextTask.status &&
    prevTask.title === nextTask.title &&
    prevTask.description === nextTask.description &&
    prevTask.updatedAt === nextTask.updatedAt &&
    prevTask.reviewReason === nextTask.reviewReason &&
    prevTask.metadata?.autoMerge?.sha === nextTask.metadata?.autoMerge?.sha &&
    prevTask.metadata?.autoMerge?.revertedAt === nextTask.metadata?.autoMerge?.revertedAt &&
    prevTask.metadata?.autoMergeBlocked?.at === nextTask.metadata?.autoMergeBlocked?.at &&
    prevTask.claudeRun?.reviewVerdict?.status === nextTask.claudeRun?.reviewVerdict?.status &&
    prevTask.claudeRun?.reviewVerdict?.rounds === nextTask.claudeRun?.reviewVerdict?.rounds &&
    prevTask.executionProgress?.phase === nextTask.executionProgress?.phase &&
    canResumeTask(prevTask) === canResumeTask(nextTask) &&
    prevTask.metadata?.archivedAt === nextTask.metadata?.archivedAt &&
    prevTask.metadata?.prUrl === nextTask.metadata?.prUrl &&
    prevTask.metadata?.contextNotes?.length === nextTask.metadata?.contextNotes?.length &&
    prevTask.metadata?.splitInto?.taskIds.length === nextTask.metadata?.splitInto?.taskIds.length &&
    prevTask.metadata?.agentOverride === nextTask.metadata?.agentOverride &&
    prevTask.metadata?.specReview?.round === nextTask.metadata?.specReview?.round
  );

  // Only log when actually re-rendering (reduces noise significantly)
  if (window.DEBUG && !isEqual) {
    const changes: string[] = [];
    if (prevTask.status !== nextTask.status) changes.push(`status: ${prevTask.status} -> ${nextTask.status}`);
    if (prevTask.executionProgress?.phase !== nextTask.executionProgress?.phase) {
      changes.push(`phase: ${prevTask.executionProgress?.phase} -> ${nextTask.executionProgress?.phase}`);
    }
    if (prevTask.subtasks.length !== nextTask.subtasks.length) {
      changes.push(`subtasks: ${prevTask.subtasks.length} -> ${nextTask.subtasks.length}`);
    }
    console.log(`[TaskCard] Re-render: ${prevTask.id} | ${changes.join(', ') || 'other fields'}`);
  }

  return isEqual;
}

export const TaskCard = memo(function TaskCard({
  task,
  onClick,
  onStatusChange
}: TaskCardProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const [isStuck, setIsStuck] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  // Why starting or retrying from the card failed, shown under the description
  const [actionError, setActionError] = useState<string | null>(null);
  // Start over asks first: it discards the worktree (a backup branch keeps the work)
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  // Where a start over saved the discarded work, shown under the description
  const [notice, setNotice] = useState<string | null>(null);
  const stuckIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // A string, so the selector returns a stable value
  const autonomous = useProjectStore((s) => s.projects.find((p) => p.id === task.projectId)?.settings?.autonomous === true);
  const waitsFor = useTaskStore((s) =>
    task.status === 'queue' || task.status === 'backlog' ? unmetDependencyTitles(s.tasks, task, autonomous) : ''
  );
  // A string (or undefined), so the memoized card compares it cheaply
  const lastNoteFrom = task.metadata?.contextNotes?.filter((n) => n.kind !== 'split').at(-1)?.fromTaskId;
  const splitCount = task.metadata?.splitInto?.taskIds.length ?? 0;
  const isRunning = task.status === 'in_progress';
  // Validation (AI Review) also runs Claude Code, so it can be left stuck too (e.g. by an app quit)
  const isActive = isRunning || task.status === 'ai_review';

  // Check if task is in human_review but has no completed subtasks (crashed/incomplete)
  const isIncomplete = isIncompleteHumanReview(task);
  // Stopped or failed with an unfinished step: Resume continues the same worktree and session
  const validationOn = useSettingsStore((state) => state.settings.claudeCodeTasks?.validation) !== false;
  const canResume = !isStuck && !isIncomplete && canResumeTask(task, validationOn);
  // A stuck task (the app quit mid-run) continues its unfinished run; a finished one just moves on
  const stuckRunFinished = isStuck && isRunFinished(task.claudeRun, validationOn);
  const [isRecovering, setIsRecovering] = useState(false);
  const handleRecoverStuck = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRecovering(true);
    const result = await recoverStuckTask(task.id, !stuckRunFinished, task.projectId);
    setIsRecovering(false);
    if (result.success) {
      setIsStuck(false);
      setActionError(null);
    } else {
      setActionError(t('actions.recoverFailed', { error: result.error ?? '' }));
    }
  };

  // Memoize expensive computations to avoid running on every render
  // Truncate description for card display - full description shown in modal
  // Handle JSON error tasks with i18n
  const sanitizedDescription = useMemo(() => {
    if (!task.description) return null;
    // Check for JSON error marker and use i18n
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      const translatedDesc = t('errors:task.jsonError.description', { error: errorMessage });
      return sanitizeMarkdownForDisplay(translatedDesc, 120);
    }
    return sanitizeMarkdownForDisplay(task.description, 120);
  }, [task.description, t]);

  // Memoize title with JSON error suffix handling
  const displayTitle = useMemo(() => {
    if (task.title.endsWith(JSON_ERROR_TITLE_SUFFIX)) {
      const baseName = task.title.slice(0, -JSON_ERROR_TITLE_SUFFIX.length);
      return `${baseName} ${t('errors:task.jsonError.titleSuffix')}`;
    }
    return task.title;
  }, [task.title, t]);

  // Memoize relative time (recalculates only when updatedAt changes)
  const relativeTime = useMemo(
    () => formatRelativeTime(task.updatedAt),
    [task.updatedAt]
  );

  // Memoize status menu items to avoid recreating on every render.
  // Lists only the columns the task may move to (same rule as drag and drop).
  const statusMenuItems = useMemo(() => {
    if (!onStatusChange) return null;
    const allowedMoves = getAllowedTaskMoves(task.status);
    if (allowedMoves.length === 0) return null;
    return allowedMoves.map((status) => (
      <DropdownMenuItem
        key={status}
        onClick={() => onStatusChange(status)}
      >
        {t(TASK_STATUS_LABELS[status])}
      </DropdownMenuItem>
    ));
  }, [task.status, onStatusChange, t]);

  // Catastrophic stuck detection — last-resort safety net.
  // XState handles all normal transitions via PROCESS_EXITED events.
  // This only fires if XState somehow fails to transition after 60s with no activity.
  useEffect(() => {
    if (!isActive) {
      setIsStuck(false);
      if (stuckIntervalRef.current) {
        clearInterval(stuckIntervalRef.current);
        stuckIntervalRef.current = null;
      }
      return;
    }

    const checkStuck = () => {
      // If any activity (status, progress, logs) was recorded recently, task is alive
      if (hasRecentActivity(task.id)) {
        setIsStuck(false);
        return;
      }

      // No recent activity: verify the process is actually gone
      // The card's own project: the same task id can sit on another project's board
      checkTaskRunning(task.id, task.projectId).then((actuallyRunning) => {
        // Re-check activity in case something arrived while the IPC was in flight
        if (hasRecentActivity(task.id)) {
          setIsStuck(false);
        } else {
          setIsStuck(!actuallyRunning);
        }
      });
    };
    // Check right away (a run stopped by quitting the app is stuck as soon as the app starts)
    checkStuck();
    stuckIntervalRef.current = setInterval(checkStuck, isStuck ? STUCK_RECHECK_MS : STUCK_CHECK_INTERVAL_MS);

    return () => {
      if (stuckIntervalRef.current) {
        clearInterval(stuckIntervalRef.current);
      }
    };
  }, [task.id, isActive, isStuck]);

  const handleStartStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      // Allow stopping both running and stuck tasks
      // User should be able to force-stop a stuck task
      stopTask(task.id, task.projectId);
    } else {
      // A queued task moves to the Queue column, so only a failure needs telling
      const result = await startTaskOrQueue(task.id);
      setActionError(result.success ? null : result.error || t('tasks:wizard.errors.startFailed'));
    }
  };

  // A stuck task (marked running without a run) starts over (after the confirmation): continuing
  // its broken session could pick up where it went wrong. The work is saved to a backup branch first
  const handleStartOver = async () => {
    setIsRetrying(true);
    const result = await retryTask(task.id, task.projectId);
    setIsRetrying(false);
    setConfirmStartOver(false);
    if (result.success) {
      setIsStuck(false);
      setActionError(null);
      setNotice(result.backupBranch ? t('startOverDialog.savedWork', { branch: result.backupBranch }) : null);
    } else {
      setActionError(result.error || t('wizard.errors.startFailed'));
    }
  };

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await archiveTasks(task.projectId, [task.id]);
    if (!result.success) {
      console.error('[TaskCard] Failed to archive task:', task.id, result.error);
    }
  };

  const handleViewPR = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.metadata?.prUrl && window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(task.metadata.prUrl);
    }
  };

  const isArchived = !!task.metadata?.archivedAt;
  // Autonomous mode: merged into its target branch on its own (a string, so the memoized card compares it cheaply)
  const autoMergedInto = task.status === 'human_review' ? activeAutoMerge(task)?.branch : undefined;
  const autoMergeBlocked = task.status === 'human_review' ? task.metadata?.autoMergeBlocked : undefined;
  // Human Review after every AI review round failed (a number, so the memoized card compares it cheaply)
  const failedReviewRounds = task.status === 'human_review' && task.claudeRun?.reviewVerdict?.status === 'failed'
    ? task.claudeRun.reviewVerdict.rounds
    : 0;
  // Stable references from the store; the label is derived here
  const agentBackendSettings = useSettingsStore((state) => state.settings.agentBackend);
  const pinnedLabel = pinnedModelLabel(task.metadata?.agentOverride, agentBackendSettings?.kind ?? 'claude', agentBackendSettings?.omp?.models);
  // Failed tasks show the usage badge's "sign in again" alert icon next to the title; stuck
  // tasks show it in the color of their "Stuck" label
  const hasErrors = taskHasErrors(task);
  const alertClass = hasErrors ? 'text-red-500' : isStuck ? 'text-warning' : null;

  return (
    <Card
      className={cn(
        'card-surface task-card-enhanced cursor-pointer',
        isArchived && 'opacity-60 hover:opacity-80'
      )}
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div>
          <div>
            {/* Title, with an alert icon at the right when the task failed */}
            <div className="flex items-start gap-2">
              <h3
                className="min-w-0 flex-1 font-bold text-sm text-foreground line-clamp-2 leading-snug wrap-anywhere"
                title={displayTitle}
              >
                {displayTitle}
              </h3>
              {alertClass && (
                <AlertCircle
                  className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', alertClass)}
                  aria-label={hasErrors ? t('reviewReason.hasErrors') : t('detailHeader.stuck')}
                />
              )}
            </div>

        {/* Description - sanitized to handle markdown content (memoized); long paths and URLs
            wrap instead of widening the card past its column */}
        {sanitizedDescription && (
          <p className="mt-1.5 text-sm text-(--nav-label-color) line-clamp-2 wrap-anywhere">
            {sanitizedDescription}
          </p>
        )}
        {task.metadata?.specReview && (
          <p className="mt-1.5 text-xs font-medium text-(--nav-label-color)">
            {task.metadata.specReview.maxRounds !== undefined
              ? t('specReview.cardRound', { round: task.metadata.specReview.round + 1, max: task.metadata.specReview.maxRounds + 1 })
              : t('specReview.cardLabel')}
          </p>
        )}
        {failedReviewRounds > 0 && (
          <p className="mt-1.5 text-xs font-medium text-destructive">
            {t('aiReviewFailed.cardLabel', { count: failedReviewRounds })}
          </p>
        )}
        {autoMergedInto && (
          <p className="mt-1.5 text-xs font-medium text-(--nav-label-color) wrap-anywhere" title={t('autonomous.cardLabelTitle', { branch: autoMergedInto })}>
            {t('autonomous.cardLabel')}
          </p>
        )}
        {autoMergeBlocked && !autoMergedInto && (
          <p className="mt-1.5 text-xs font-medium text-warning line-clamp-2 wrap-anywhere" title={autoMergeBlocked.message}>
            {t(`autonomous.blocked.${autoMergeBlocked.reason}`)}
          </p>
        )}
        {splitCount > 0 && (
          <p className="mt-1.5 text-xs text-(--nav-label-color) line-clamp-1">{t('queueGrooming.splitCardLabel', { count: splitCount })}</p>
        )}
        {task.status === 'human_review' && task.reviewReason === 'split_proposed' && (
          <p className="mt-1.5 text-xs font-medium text-warning line-clamp-2">{t('queueGrooming.splitPendingCardLabel')}</p>
        )}
        {lastNoteFrom && (
          <p className="mt-1.5 text-xs text-(--nav-label-color) line-clamp-1">
            {t('queueGrooming.cardLabel', { number: taskNumber(lastNoteFrom) })}
          </p>
        )}
        {waitsFor && (
          <p className="mt-1.5 text-xs text-(--nav-label-color) line-clamp-1 wrap-anywhere" title={t('breakdown.waitsFor', { titles: waitsFor })}>
            {t('breakdown.waitsFor', { titles: waitsFor })}
          </p>
        )}
        {notice && !actionError && (
          <p className="mt-1.5 text-xs text-(--nav-label-color) line-clamp-2 wrap-anywhere">
            {notice}
          </p>
        )}
        {actionError && (
          <p role="alert" className="mt-1.5 text-xs text-destructive line-clamp-2 wrap-anywhere">
            {actionError}
          </p>
        )}

        {/* Footer */}
        <div className="mt-3 flex items-center justify-between">
          <span className="flex min-w-0 items-baseline gap-1.5 text-sm text-(--nav-label-color)">
            <span className="shrink-0">{relativeTime}</span>
            {pinnedLabel && (
              <span className="truncate text-xs" title={t('agentPicker.pinnedTitle', { model: pinnedLabel })}>
                {pinnedLabel}
              </span>
            )}
          </span>

          <div className="flex items-center gap-1.5">
            {/* Action buttons: icon buttons like the settings dialog's (label in the tooltip) */}
            {isStuck ? (
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className={ICON_BUTTON_CLASS}
                  onClick={handleRecoverStuck}
                  disabled={isRecovering || isRetrying}
                  title={t(stuckRunFinished ? 'actions.moveToReview' : 'actions.resume')}
                  aria-label={t(stuckRunFinished ? 'actions.moveToReview' : 'actions.resume')}
                >
                  {isRecovering
                    ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                    : stuckRunFinished
                      ? <ClipboardCheck className="h-4 w-4" strokeWidth={1.75} />
                      : <Play className="h-4 w-4" strokeWidth={1.75} />}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={ICON_BUTTON_CLASS}
                  onClick={(e) => { e.stopPropagation(); setConfirmStartOver(true); }}
                  disabled={isRetrying || isRecovering}
                  title={t('actions.startOver')}
                  aria-label={t('actions.startOver')}
                >
                  {isRetrying
                    ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                    : <RotateCcw className="h-4 w-4" strokeWidth={1.75} />}
                </Button>
              </div>
            ) : canResume ? (
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className={ICON_BUTTON_CLASS}
                  onClick={handleStartStop}
                  title={t('actions.resume')}
                  aria-label={t('actions.resume')}
                >
                  <Play className="h-4 w-4" strokeWidth={1.75} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={ICON_BUTTON_CLASS}
                  onClick={(e) => { e.stopPropagation(); setConfirmStartOver(true); }}
                  disabled={isRetrying}
                  title={t('actions.startOver')}
                  aria-label={t('actions.startOver')}
                >
                  {isRetrying
                    ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                    : <RotateCcw className="h-4 w-4" strokeWidth={1.75} />}
                </Button>
              </div>
            ) : isIncomplete ? (
              <Button
                variant="ghost"
                size="sm"
                className={ICON_BUTTON_CLASS}
                onClick={handleStartStop}
                title={t('actions.resume')}
                aria-label={t('actions.resume')}
              >
                <Play className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            ) : task.status === 'done' ? (
              <div className="flex gap-1">
                {task.metadata?.prUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON_CLASS}
                    onClick={handleViewPR}
                    title={t('tooltips.viewPR')}
                    aria-label={t('tooltips.viewPR')}
                  >
                    <GitPullRequest className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                )}
                {!isArchived && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON_CLASS}
                    onClick={handleArchive}
                    title={t('tooltips.archiveTask')}
                    aria-label={t('tooltips.archiveTask')}
                  >
                    <Archive className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                )}
              </div>
            ) : isRunning && (
              /* Tasks start from the task dialog; a running task can be stopped from its card */
              <Button
                variant="ghost"
                size="sm"
                className={ICON_BUTTON_CLASS}
                onClick={handleStartStop}
                title={t('actions.stop')}
                aria-label={t('actions.stop')}
              >
                <Square className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            )}

            {/* Move to menu for keyboard accessibility */}
            {statusMenuItems && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={ICON_BUTTON_CLASS}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('actions.taskActions')}
                  >
                    <MoreVertical className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuLabel>{t('actions.moveTo')}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {statusMenuItems}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        {/* Close content wrapper for selectable mode */}
        </div>
        {/* Close flex container for selectable mode */}
        </div>
      </CardContent>
      <StartOverDialog
        open={confirmStartOver}
        onOpenChange={setConfirmStartOver}
        onConfirm={() => void handleStartOver()}
        busy={isRetrying}
      />
    </Card>
  );
}, taskCardPropsAreEqual);
