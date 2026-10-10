import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useToast } from '../../hooks/use-toast';
import { Tabs, TabsContent } from '../ui/tabs';
import { SegmentedControl } from '../settings/SettingsRow';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipProvider } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { buttonVariants } from '../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  Trash2,
  Loader2,
  AlertTriangle,
  Pencil,
  X,
  ArchiveRestore,
  GitPullRequest,
  Play,
  RotateCcw
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  DIALOG_ANIMATION_CLASS,
  DIALOG_CLOSE_BUTTON_CLASS,
  DIALOG_CLOSE_ICON_CLASS,
  DIALOG_CLOSE_ICON_STROKE,
  DIALOG_OVERLAY_CLASS,
  DIALOG_SURFACE_CLASS,
  DIALOG_TITLE_CLASS
} from '../ui/dialog-styles';
import { stopTask, submitReview, recoverStuckTask, deleteTask, useTaskStore, startTaskOrQueue, unarchiveTasks, taskHasErrors, retryTask } from '../../stores/task-store';
import { useProjectStore } from '../../stores/project-store';
import { TASK_STATUS_LABELS } from '../../../shared/constants';
import { TaskEditDialog } from '../TaskEditDialog';
import { useTaskDetail } from './hooks/useTaskDetail';
import { TaskMetadata } from './TaskMetadata';
import { TaskOpenAgentButton } from './TaskOpenAgentButton';
import { TaskWarnings } from './TaskWarnings';
import { TaskLogs } from './TaskLogs';
import { TaskReview } from './TaskReview';
import type { Task, WorktreeCreatePROptions } from '../../../shared/types';

interface TaskDetailModalProps {
  open: boolean;
  task: Task | null;
  onOpenChange: (open: boolean) => void;
}

export function TaskDetailModal({ open, task, onOpenChange }: TaskDetailModalProps) {
  // Don't render anything if no task
  if (!task) {
    return null;
  }

  return (
    <TaskDetailModalContent
      open={open}
      task={task}
      onOpenChange={onOpenChange}
    />
  );
}

// Separate component to use hooks only when task exists
function TaskDetailModalContent({ open, task, onOpenChange }: { open: boolean; task: Task; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();
  const state = useTaskDetail({ task });
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  // Archived tasks can be brought back to the board from here
  const handleUnarchive = async () => {
    setIsUnarchiving(true);
    const result = await unarchiveTasks(task.projectId, [task.id]);
    setIsUnarchiving(false);
    if (!result.success) {
      toast({
        title: t('tasks:actions.unarchiveFailed', { error: result.error ?? '' }),
        variant: 'destructive'
      });
    }
  };
  const activeProject = useProjectStore(s => s.getActiveProject());

  // Event Handlers
  const handleStartStop = async () => {
    if (state.isRunning && !state.isStuck) {
      stopTask(task.id);
    } else {
      // If task is incomplete, validate and reload plan before starting
      if (state.isIncomplete) {
        const isValid = await state.reloadPlanForIncompleteTask();
        if (!isValid) {
          toast({
            title: t('tasks:detail.resumeFailedTitle'),
            description: t('tasks:detail.resumeFailedDescription'),
            variant: 'destructive',
            duration: 5000,
          });
          return;
        }
      }
      const result = await startTaskOrQueue(task.id);
      if (!result.success) {
        toast({
          title: t('tasks:wizard.errors.startFailed'),
          description: result.error,
          variant: 'destructive',
        });
      } else if (result.action === 'queued') {
        toast({ title: t('tasks:queue.movedToQueue') });
      }
    }
  };

  // Retry starts the task over: worktree changes and the previous run are discarded
  const handleRetry = async () => {
    setIsRetrying(true);
    const result = await retryTask(task.id);
    setIsRetrying(false);
    if (!result.success) {
      toast({
        title: t('tasks:wizard.errors.startFailed'),
        description: result.error,
        variant: 'destructive',
      });
    } else if (result.action === 'queued') {
      toast({ title: t('tasks:queue.movedToQueue') });
    }
  };

  const handleRecover = async () => {
    state.setIsRecovering(true);
    const result = await recoverStuckTask(task.id, { autoRestart: true });
    if (result.success) {
      state.setIsStuck(false);
      state.setHasCheckedRunning(false);
    }
    state.setIsRecovering(false);
  };

  const handleReject = async () => {
    // Allow submission if there's text feedback OR images attached
    if (!state.feedback.trim() && state.feedbackImages.length === 0) {
      return;
    }
    state.setIsSubmitting(true);
    await submitReview(task.id, false, state.feedback, state.feedbackImages);
    state.setIsSubmitting(false);
    state.setFeedback('');
    state.setFeedbackImages([]);
  };

  const handleDelete = async () => {
    state.setIsDeleting(true);
    state.setDeleteError(null);
    const result = await deleteTask(task.id);
    if (result.success) {
      state.setShowDeleteDialog(false);
      onOpenChange(false);
    } else {
      state.setDeleteError(result.error || t('tasks:deleteDialog.failed'));
    }
    state.setIsDeleting(false);
  };

  const handleMerge = async () => {
    state.setIsMerging(true);
    state.setWorkspaceError(null);
    try {
      const result = await window.electronAPI.mergeWorktree(task.id, { noCommit: state.stageOnly });
      if (result.success && result.data?.success) {
        if (state.stageOnly && result.data.staged) {
          state.setWorkspaceError(null);
          state.setStagedSuccess(result.data.message || 'Changes staged in main project');
          state.setStagedProjectPath(result.data.projectPath);
          state.setSuggestedCommitMessage(result.data.suggestedCommitMessage);
        } else {
          onOpenChange(false);
        }
      } else {
        state.setWorkspaceError(result.data?.message || result.error || 'Failed to merge changes');
      }
    } catch (error) {
      state.setWorkspaceError(error instanceof Error ? error.message : 'Unknown error during merge');
    } finally {
      state.setIsMerging(false);
    }
  };

  const handleCreatePR = async (options: WorktreeCreatePROptions) => {
    state.setIsCreatingPR(true);
    try {
      const result = await window.electronAPI.createWorktreePR(task.id, options);
      if (result.success && result.data) {
        // Update single task in store with new status and prUrl (more efficient than reloading all tasks)
        if (result.data.success && result.data.prUrl && !result.data.alreadyExists) {
          useTaskStore.getState().updateTask(task.id, {
            status: 'done',
            metadata: { ...task.metadata, prUrl: result.data.prUrl }
          });
        }
        return result.data;
      }
      // Propagate IPC error; let CreatePRDialog use its i18n fallback
      return { success: false, error: result.error, prUrl: undefined, alreadyExists: false };
    } catch (error) {
      // Propagate actual error message; let CreatePRDialog handle i18n fallback for undefined
      return { success: false, error: error instanceof Error ? error.message : undefined, prUrl: undefined, alreadyExists: false };
    } finally {
      state.setIsCreatingPR(false);
    }
  };

  const handleClose = () => {
    // Show toast notification if task is running
    if (state.isRunning && !state.isStuck) {
      toast({
        title: t('tasks:notifications.backgroundTaskTitle'),
        description: t('tasks:notifications.backgroundTaskDescription'),
        duration: 4000,
      });
    }
    onOpenChange(false);
  };

  // Helper function to get status badge variant
  const getStatusBadgeVariant = (status: string, isStuck: boolean) => {
    if (isStuck) return 'warning';
    switch (status) {
      case 'done':
        return 'success';
      case 'human_review':
        return 'purple';
      case 'in_progress':
        return 'info';
      default:
        return 'secondary';
    }
  };



  return (
    <TooltipProvider delayDuration={300}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          {/* Semi-transparent overlay - can see background content */}
          <DialogPrimitive.Overlay className={DIALOG_OVERLAY_CLASS} />

          {/* Full-height centered modal content */}
          <DialogPrimitive.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-50',
              '-translate-x-1/2 -translate-y-1/2',
              'w-[min(760px,calc(100vw-2rem))] h-[min(600px,calc(100vh-2rem))]',
              'overflow-hidden flex flex-col',
              DIALOG_SURFACE_CLASS,
              DIALOG_ANIMATION_CLASS
            )}
          >
            {/* Header */}
            {/* pr-14 keeps the title clear of the close button */}
            <div className="relative shrink-0 px-6 pb-4 pr-14 pt-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <DialogPrimitive.Title className={cn(DIALOG_TITLE_CLASS, 'truncate')}>
                    {task.title}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description asChild>
                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-xs font-mono">
                        {task.specId}
                      </Badge>
                      {/* Branch the task's worktree merges into */}
                      {state.worktreeStatus?.exists && (
                        <>
                          <span className="text-xs text-muted-foreground" aria-hidden="true">→</span>
                          <Badge
                            variant="outline"
                            className="text-xs font-mono"
                            title={t('taskReview:workspace.targetBranch')}
                          >
                            {state.worktreeStatus.currentProjectBranch || state.worktreeStatus.baseBranch || 'main'}
                          </Badge>
                        </>
                      )}
                      {state.isStuck ? (
                        <Badge variant="warning" className="text-xs flex items-center gap-1 animate-pulse">
                          <AlertTriangle className="h-3 w-3" />
                          {t('tasks:detailHeader.stuck')}
                        </Badge>
                      ) : state.isIncomplete ? (
                        <Badge variant="warning" className="text-xs flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {t('tasks:detailHeader.incomplete')}
                          </Badge>
                      ) : (
                        <Badge
                          variant={getStatusBadgeVariant(task.status, state.isStuck)}
                          className={cn('text-xs', (task.status === 'in_progress' && !state.isStuck) && 'status-running')}
                        >
                          {t(TASK_STATUS_LABELS[task.status])}
                        </Badge>
                      )}
                    </div>
                  </DialogPrimitive.Description>
                  {window.DEBUG && (
                    <div className="mt-1 text-[11px] text-muted-foreground font-mono">
                      status={task.status} reviewReason={task.reviewReason ?? 'none'} phase={task.executionProgress?.phase ?? 'none'} session={task.claudeRun?.sessionId ?? 'none'}
                      <br />
                      projectId={activeProject?.id ?? 'none'} projectName={activeProject?.name ?? 'none'}
                    </div>
                  )}
                </div>
                <div className="absolute right-3 top-3 z-10 flex items-center gap-1 electron-no-drag">
                  <DialogPrimitive.Close
                    className={cn(DIALOG_CLOSE_BUTTON_CLASS, 'static')}
                    aria-label={t('common:buttons.close')}
                  >
                    <X className={DIALOG_CLOSE_ICON_CLASS} strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  </DialogPrimitive.Close>
                </div>
              </div>


              {/* Warnings - compact inline */}
              {(state.isStuck || state.isIncomplete) && (
                <div className="mt-3">
                  <TaskWarnings
                    isStuck={state.isStuck}
                    isIncomplete={state.isIncomplete}
                    isRecovering={state.isRecovering}
                    taskProgress={state.taskProgress}
                    onRecover={handleRecover}
                    onResume={handleStartStop}
                  />
                </div>
              )}
            </div>

            {/* Body - Single Column with Tabs */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Tabs value={state.activeTab} onValueChange={state.setActiveTab} className="flex flex-col h-full">
                {/* Tabs as a segmented control, like the settings dialog */}
                <div className="shrink-0 px-6 pb-3">
                  <SegmentedControl
                    value={state.activeTab}
                    onValueChange={state.setActiveTab}
                    ariaLabel={t('tasks:detailTabs.label')}
                    options={[
                      { value: 'overview', label: t('tasks:detailTabs.overview') },
                      { value: 'logs', label: t('tasks:detailTabs.logs') }
                    ]}
                  />
                </div>

                {/* Overview Tab */}
                <TabsContent value="overview" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <ScrollArea className="h-full">
                    <div className="p-6 space-y-5 overflow-x-hidden max-w-full">
                      {/* Metadata */}
                      <TaskMetadata
                        task={task}
                        worktreeStatus={state.worktreeStatus}
                        worktreeAction={(task.claudeRun?.sessionId || task.metadata?.prUrl || (state.needsReview && state.worktreeStatus?.exists)) ? (
                          <>
                            <TaskOpenAgentButton task={task} />
                            {/* A PR that exists opens in the browser; otherwise create one (primary action) */}
                            {task.metadata?.prUrl ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1.5"
                                onClick={() => void window.electronAPI.openExternal(task.metadata!.prUrl!)}
                              >
                                <GitPullRequest className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                                {t('common:buttons.openPR')}
                              </Button>
                            ) : state.needsReview && state.worktreeStatus?.exists && (
                              <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={() => state.setShowPRDialog(true)}
                                disabled={state.isMerging || state.isCreatingPR}
                              >
                                {state.isCreatingPR ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <GitPullRequest className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                                )}
                                {state.isCreatingPR ? t('taskReview:pr.actions.creating') : t('common:buttons.createPR')}
                              </Button>
                            )}
                          </>
                        ) : undefined}
                      />

                      {/* Human Review Section */}
                      {state.needsReview && (
                        <>
                          <TaskReview
                            task={task}
                            feedback={state.feedback}
                            isSubmitting={state.isSubmitting}
                            worktreeStatus={state.worktreeStatus}
                            isLoadingWorktree={state.isLoadingWorktree}
                            isMerging={state.isMerging}
                            workspaceError={state.workspaceError}
                            stageOnly={state.stageOnly}
                            stagedSuccess={state.stagedSuccess}
                            stagedProjectPath={state.stagedProjectPath}
                            suggestedCommitMessage={state.suggestedCommitMessage}
                            mergePreview={state.mergePreview}
                            isLoadingPreview={state.isLoadingPreview}
                            showConflictDialog={state.showConflictDialog}
                            onFeedbackChange={state.setFeedback}
                            onReject={handleReject}
                            images={state.feedbackImages}
                            onImagesChange={state.setFeedbackImages}
                            onMerge={handleMerge}
                            onStageOnlyChange={state.setStageOnly}
                            onShowConflictDialog={state.setShowConflictDialog}
                            onLoadMergePreview={state.loadMergePreview}
                            onClose={handleClose}
                            onReviewAgain={state.handleReviewAgain}
                            showPRDialog={state.showPRDialog}
                            isCreatingPR={state.isCreatingPR}
                            onShowPRDialog={state.setShowPRDialog}
                            onCreatePR={handleCreatePR}
                          />
                        </>
                      )}
                    </div>
                  </ScrollArea>
                </TabsContent>

                {/* Logs Tab */}
                <TabsContent value="logs" className="flex-1 min-h-0 overflow-hidden mt-0">
                  <TaskLogs
                    task={task}
                    phaseLogs={state.phaseLogs}
                    isLoadingLogs={state.isLoadingLogs}
                    expandedPhases={state.expandedPhases}
                    logsEndRef={state.logsEndRef}
                    logsContainerRef={state.logsContainerRef}
                    onLogsScroll={state.handleLogsScroll}
                    onTogglePhase={state.togglePhase}
                  />
                </TabsContent>

              </Tabs>
            </div>

            {/* Footer: task actions (the close button stays at the top) */}
            <div className="flex shrink-0 items-center justify-end gap-1 px-6 py-3 electron-no-drag">
              {task.metadata?.archivedAt && (
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleUnarchive} disabled={isUnarchiving}>
                  {isUnarchiving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArchiveRestore className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  )}
                  {t('tasks:actions.unarchive')}
                </Button>
              )}
              {/* Retry a task that stopped with an error: starts it over from a clean worktree */}
              {taskHasErrors(task) && !state.isRunning && (
                <Button variant="ghost" size="sm" className="gap-1.5" disabled={isRetrying} onClick={() => void handleRetry()}>
                  {isRetrying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  )}
                  {t('tasks:actions.retry')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => state.setShowDeleteDialog(true)}
                disabled={state.isRunning && !state.isStuck}
              >
                <Trash2 className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                {t('tasks:actions.delete')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => state.setIsEditDialogOpen(true)}
                disabled={state.isRunning && !state.isStuck}
              >
                <Pencil className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                {t('tasks:actions.edit')}
              </Button>
              {/* Start a task waiting in Planning (Backlog) */}
              {task.status === 'backlog' && (
                <Button size="sm" className="gap-1.5" onClick={() => void handleStartStop()}>
                  <Play className="h-4 w-4" strokeWidth={DIALOG_CLOSE_ICON_STROKE} />
                  {t('tasks:actions.start')}
                </Button>
              )}
            </div>

          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* Edit Task Dialog */}
      <TaskEditDialog
        task={task}
        open={state.isEditDialogOpen}
        onOpenChange={state.setIsEditDialogOpen}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={state.showDeleteDialog} onOpenChange={state.setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('tasks:deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {t('tasks:deleteDialog.confirmMessage')} <span className="text-foreground">"{task.title}"</span>?
                </p>
                {state.isCheckingChanges && (
                  <p className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('tasks:deleteDialog.checkingChanges')}
                  </p>
                )}
                {state.worktreeChangesInfo?.hasChanges && (
                  <p className="text-destructive">
                    {t('tasks:deleteDialog.uncommittedChanges', { count: state.worktreeChangesInfo.changedFileCount })}.{' '}
                    {t('tasks:deleteDialog.uncommittedChangesHint')}
                  </p>
                )}
                <p className="rounded-xl bg-segment-track px-4 py-3 text-foreground">
                  {t('tasks:deleteDialog.destructiveWarning')}
                </p>
                {state.deleteError && (
                  <p className="text-destructive">{state.deleteError}</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={state.isDeleting}>{t('tasks:deleteDialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={state.isDeleting}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {state.isDeleting ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t('tasks:deleteDialog.deleting')}
                </>
              ) : (
                t('tasks:deleteDialog.deletePermanently')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
