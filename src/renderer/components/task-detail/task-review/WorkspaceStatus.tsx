import { useState, useEffect, useRef, type ReactNode } from 'react';
import {
  Loader2,
  RotateCcw
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { Switch } from '../../ui/switch';
import { SettingsRow, SettingsRows } from '../../settings/SettingsRow';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { MergeProgressOverlay } from './MergeProgressOverlay';
import type { WorktreeStatus, MergeConflict, MergeStats, GitConflictInfo, MergeProgress, MergeLogEntry, MergeLogEntryType } from '../../../../shared/types';

// Maximum log entries to keep to prevent memory issues during long merges
const MAX_LOG_ENTRIES = 500;

interface WorkspaceStatusProps {
  taskId: string;
  worktreeStatus: WorktreeStatus;
  workspaceError: string | null;
  stageOnly: boolean;
  mergePreview: { files: string[]; conflicts: MergeConflict[]; summary: MergeStats; gitConflicts?: GitConflictInfo; uncommittedChanges?: { hasChanges: boolean; files: string[]; count: number } | null } | null;
  isLoadingPreview: boolean;
  isMerging: boolean;
  onShowConflictDialog: (show: boolean) => void;
  onLoadMergePreview: () => void;
  onStageOnlyChange: (value: boolean) => void;
  onMerge: () => void;
  /** Content shown between the workspace details and the action buttons (e.g. the request-changes form) */
  beforeActions?: ReactNode;
}

/**
 * Displays the workspace status: change summary, branch, merge preview and actions
 */
export function WorkspaceStatus({
  taskId,
  worktreeStatus,
  workspaceError,
  stageOnly,
  mergePreview,
  isLoadingPreview,
  isMerging,
  onShowConflictDialog,
  onLoadMergePreview,
  onStageOnlyChange,
  onMerge,
  beforeActions
}: WorkspaceStatusProps) {
  const { t } = useTranslation(['taskReview', 'common', 'tasks']);

  // Merge progress state
  const [mergeProgress, setMergeProgress] = useState<MergeProgress | null>(null);
  const [logEntries, setLogEntries] = useState<MergeLogEntry[]>([]);
  const [showOverlay, setShowOverlay] = useState(false);
  const prevIsMergingRef = useRef(isMerging);
  const mergeStartTimeRef = useRef<number | null>(null);
  const minDisplayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ipcCleanupRef = useRef<(() => void) | null>(null);

  // Reset state when isMerging transitions from false → true
  useEffect(() => {
    if (isMerging && !prevIsMergingRef.current) {
      setMergeProgress(null);
      setLogEntries([]);
      setShowOverlay(true);
      mergeStartTimeRef.current = Date.now();
    }
    prevIsMergingRef.current = isMerging;
  }, [isMerging]);

  // Minimum display time: keep overlay visible for at least 500ms after merge ends
  // Also wait for terminal progress event (complete/error) to avoid hiding before final message
  useEffect(() => {
    if (!isMerging && showOverlay && mergeStartTimeRef.current !== null) {
      // Check if we received a terminal progress event (complete or error)
      const hasTerminalEvent = mergeProgress?.stage === 'complete' || mergeProgress?.stage === 'error';

      // Only hide if we have a terminal event OR if a fallback timeout expires
      if (hasTerminalEvent) {
        const elapsed = Date.now() - mergeStartTimeRef.current;
        const MIN_DISPLAY_MS = 500;
        const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);

        if (remaining > 0) {
          minDisplayTimerRef.current = setTimeout(() => {
            setShowOverlay(false);
            mergeStartTimeRef.current = null;
          }, remaining);
        } else {
          setShowOverlay(false);
          mergeStartTimeRef.current = null;
        }
      } else {
        // Fallback: hide after 2s if no terminal event received (defensive)
        minDisplayTimerRef.current = setTimeout(() => {
          setShowOverlay(false);
          mergeStartTimeRef.current = null;
        }, 2000);
      }
    }

    return () => {
      if (minDisplayTimerRef.current) {
        clearTimeout(minDisplayTimerRef.current);
        minDisplayTimerRef.current = null;
      }
    };
  }, [isMerging, showOverlay, mergeProgress?.stage]);

  // Subscribe to merge progress IPC events
  useEffect(() => {
    if (!isMerging) return;

    const stageToLogType = (stage: string): MergeLogEntryType => {
      switch (stage) {
        case 'complete': return 'success';
        case 'error': return 'error';
        case 'resolving': return 'warning';
        default: return 'info';
      }
    };

    const cleanup = window.electronAPI.onMergeProgress((eventTaskId: string, progress: MergeProgress) => {
      // Filter by task ID to prevent cross-task event leakage
      if (eventTaskId !== taskId) return;

      setMergeProgress(progress);
      setLogEntries(prev => {
        const newEntry = {
          timestamp: new Date().toISOString(),
          type: stageToLogType(progress.stage),
          message: progress.message,
          details: progress.details?.current_file,
        };
        // Limit log entries to prevent unbounded growth during long merges
        const updated = [...prev, newEntry];
        if (updated.length > MAX_LOG_ENTRIES) {
          return updated.slice(-MAX_LOG_ENTRIES);
        }
        return updated;
      });
    });

    // Store cleanup ref so we can call it on unmount even if isMerging changes
    ipcCleanupRef.current = cleanup;

    return cleanup;
  }, [isMerging, taskId]);

  // Ensure IPC listener cleanup on unmount during active merge
  useEffect(() => {
    return () => {
      if (ipcCleanupRef.current) {
        ipcCleanupRef.current();
        ipcCleanupRef.current = null;
      }
      if (minDisplayTimerRef.current) {
        clearTimeout(minDisplayTimerRef.current);
      }
    };
  }, []);

  const hasGitConflicts = mergePreview?.gitConflicts?.hasConflicts;
  const hasUncommittedChanges = mergePreview?.uncommittedChanges?.hasChanges;
  const uncommittedCount = mergePreview?.uncommittedChanges?.count || 0;
  const hasAIConflicts = mergePreview && mergePreview.conflicts.length > 0;

  // Conflict scenario detection for better UX messaging
  const conflictScenario = mergePreview?.gitConflicts?.scenario;
  const alreadyMergedFiles = mergePreview?.gitConflicts?.alreadyMergedFiles || [];
  const isAlreadyMerged = conflictScenario === 'already_merged';
  const isSuperseded = conflictScenario === 'superseded';

  // Check if branch needs rebase (main has advanced since spec was created)
  // This requires AI merge even if no explicit file conflicts are detected
  const needsRebase = mergePreview?.gitConflicts?.needsRebase;
  const commitsBehind = mergePreview?.gitConflicts?.commitsBehind || 0;

  // Path-mapped files that need AI merge due to file renames
  const pathMappedAIMergeCount = mergePreview?.summary?.pathMappedAIMergeCount || 0;
  const totalRenames = mergePreview?.gitConflicts?.totalRenames || 0;

  // Branch is behind if needsRebase is true and there are commits to catch up on
  // This triggers AI merge for path-mapped files even without explicit conflicts
  const isBranchBehind = needsRebase && commitsBehind > 0;

  // Has path-mapped files that need AI merge
  const hasPathMappedMerges = pathMappedAIMergeCount > 0;

  const targetBranch = worktreeStatus.currentProjectBranch || worktreeStatus.baseBranch || 'main';
  const needsAIMerge = hasGitConflicts || isBranchBehind || hasPathMappedMerges;
  const showMergeStatus = mergePreview && !isAlreadyMerged && !isSuperseded;

  // Merge status row: title + muted detail line
  let mergeStatusTitle = '';
  let mergeStatusDetail: ReactNode = null;
  if (mergePreview && showMergeStatus) {
    if (hasGitConflicts) {
      mergeStatusTitle = t('taskReview:merge.status.branchDiverged');
      mergeStatusDetail = (
        <>
          {t('taskReview:merge.status.aiWillResolve')}.{' '}
          {mergePreview.gitConflicts && (
            <>
              {t('taskReview:merge.branchHasNewCommits', { branch: mergePreview.gitConflicts.baseBranch, count: mergePreview.gitConflicts.commitsBehind })}
              {mergePreview.gitConflicts.conflictingFiles.length > 0 && (
                <>{' '}{t('taskReview:merge.filesNeedMerging', { count: mergePreview.gitConflicts.conflictingFiles.length })}</>
              )}
            </>
          )}
        </>
      );
    } else if (isBranchBehind || hasPathMappedMerges) {
      mergeStatusTitle = hasPathMappedMerges ? t('taskReview:merge.status.filesRenamed') : t('taskReview:merge.status.branchBehind');
      mergeStatusDetail = (
        <>
          {t('taskReview:merge.status.aiWillResolve')} ({hasPathMappedMerges
            ? `${pathMappedAIMergeCount} ${t('taskReview:merge.status.files')}`
            : t('taskReview:workspace.commitCount', { count: commitsBehind })}).
          {isBranchBehind && mergePreview.gitConflicts && (
            <>
              {' '}{t('taskReview:merge.branchHasNewCommitsSinceBuild', { branch: mergePreview.gitConflicts.baseBranch, count: commitsBehind })}
              {' '}
              {hasPathMappedMerges
                ? t(totalRenames === 1 ? 'taskReview:merge.filesNeedAIMergeDueToRenames' : 'taskReview:merge.filesNeedAIMergeDueToRenamesPlural', { renameCount: totalRenames, count: pathMappedAIMergeCount })
                : totalRenames > 0
                  ? t('taskReview:merge.fileRenamesDetected', { count: totalRenames })
                  : t('taskReview:merge.filesRenamedOrMoved')}
            </>
          )}
        </>
      );
    } else if (!hasAIConflicts) {
      mergeStatusTitle = t('taskReview:merge.status.readyToMerge');
      mergeStatusDetail = `${mergePreview.summary.totalFiles} ${t('taskReview:merge.status.files')}`;
    } else {
      mergeStatusTitle = `${mergePreview.conflicts.length} ${mergePreview.conflicts.length !== 1 ? t('taskReview:merge.status.conflicts') : t('taskReview:merge.status.conflict')}`;
    }
  }

  const actionsDisabled = isMerging;

  return (
    <div className="space-y-3">
      <SettingsRows>

        {/* Merge status */}
        {mergePreview && showMergeStatus && (
          <SettingsRow
            label={mergeStatusTitle}
            description={mergeStatusDetail}
          >
            {(needsAIMerge || hasAIConflicts) && (
              <Button variant="outline" size="sm" onClick={() => onShowConflictDialog(true)}>
                {t('taskReview:merge.status.details')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={onLoadMergePreview}
              disabled={isLoadingPreview}
              className="w-8 px-0 text-muted-foreground"
              title={t('taskReview:merge.status.refresh')}
              aria-label={t('taskReview:merge.status.refresh')}
            >
              {isLoadingPreview ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
              )}
            </Button>
          </SettingsRow>
        )}

        {/* Stage only option - only after conflicts have been checked */}
        {showMergeStatus && (
          <SettingsRow
            label={t('taskReview:merge.status.stageOnly')}
            description={t('taskReview:merge.status.stageOnlyDescription')}
            htmlFor={`stage-only-${taskId}`}
          >
            <Switch
              id={`stage-only-${taskId}`}
              checked={stageOnly}
              onCheckedChange={onStageOnlyChange}
            />
          </SettingsRow>
        )}
      </SettingsRows>

      {/* Workspace error */}
      {workspaceError && <p className="text-sm text-destructive">{workspaceError}</p>}

      {/* Uncommitted changes in the main project */}
      {hasUncommittedChanges && (
        <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
          <p className="text-foreground">{t('taskReview:workspace.uncommittedChanges', { count: uncommittedCount })}</p>
          <p className="mt-0.5 text-(--nav-label-color)">{t('taskReview:workspace.uncommittedChangesHint')}</p>
        </div>
      )}

      {/* Already merged: changes already exist in the target branch */}
      {mergePreview && isAlreadyMerged && (
        <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
          <p className="text-foreground">{t('taskReview:merge.alreadyMergedTitle')}</p>
          <p className="mt-0.5 text-(--nav-label-color)">{t('taskReview:merge.alreadyMergedDescription')}</p>
          {alreadyMergedFiles.length > 0 && alreadyMergedFiles.length <= 5 && (
            <div className="mt-2 text-(--nav-label-color)">
              <span>{t('taskReview:merge.matchingFiles')}:</span>
              <ul className="mt-1 space-y-0.5">
                {alreadyMergedFiles.map(file => (
                  <li key={file} className="truncate font-mono text-xs">{file}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Superseded: target has a newer version of the changes */}
      {mergePreview && isSuperseded && (
        <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
          <p className="text-foreground">{t('taskReview:merge.supersededTitle')}</p>
          <p className="mt-0.5 text-(--nav-label-color)">{t('taskReview:merge.supersededDescription')}</p>
        </div>
      )}

      {/* Merge Progress Overlay — shown during merge and for minimum display time after */}
      {(isMerging || showOverlay) && (
        <MergeProgressOverlay mergeProgress={mergeProgress} logEntries={logEntries} />
      )}

      {beforeActions}

      {/* Actions: check for conflicts, create PR, merge (below everything else) */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Superseded - view comparison */}
        {mergePreview && !isLoadingPreview && isSuperseded && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => onShowConflictDialog(true)} disabled={actionsDisabled}>
                {t('taskReview:merge.actions.viewComparison')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{t('taskReview:merge.supersededCompareTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Already merged - mark as done */}
        {mergePreview && !isLoadingPreview && isAlreadyMerged && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={onMerge} disabled={actionsDisabled}>
                {isMerging ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('taskReview:merge.buttons.completing')}
                  </>
                ) : (
                  t('taskReview:merge.actions.markAsDone')
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{t('taskReview:merge.alreadyMergedTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Normal merge / stage */}
        {mergePreview && !isLoadingPreview && showMergeStatus && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={onMerge} disabled={actionsDisabled}>
                {isMerging ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {needsAIMerge
                      ? t('taskReview:merge.buttons.resolving')
                      : stageOnly
                        ? t('taskReview:merge.buttons.staging')
                        : t('taskReview:merge.buttons.merging')}
                  </>
                ) : needsAIMerge ? (
                  stageOnly ? t('taskReview:merge.buttons.stageWithAIMerge') : t('taskReview:merge.buttons.mergeWithAI')
                ) : stageOnly ? (
                  t('taskReview:merge.buttons.stageTo', { branch: targetBranch })
                ) : (
                  t('taskReview:merge.buttons.mergeTo', { branch: targetBranch })
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="max-w-xs">{t('tasks:review.mergeTooltip')}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
