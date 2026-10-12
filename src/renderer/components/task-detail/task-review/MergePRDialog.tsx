import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Button } from '../../ui/button';
import { ExternalLink } from '../../ui/external-link';
import { SettingsRow, SettingsRows } from '../../settings/SettingsRow';
import type { MergePRProgress, Task, WorktreeMergePROptions, WorktreeMergePRResult, WorktreeStatus } from '../../../../shared/types';

interface MergePRDialogProps {
  open: boolean;
  task: Task;
  worktreeStatus: WorktreeStatus | null;
  onOpenChange: (open: boolean) => void;
  onMergePR: (options: WorktreeMergePROptions) => Promise<WorktreeMergePRResult>;
}

/**
 * Dialog for merging a task's pull request into the branch it targets (read from GitHub when the
 * merge runs). That branch is pulled into the task branch first; Claude Code resolves conflicts,
 * keeping the changes other tasks merged.
 */
export function MergePRDialog({ open, task, worktreeStatus, onOpenChange, onMergePR }: MergePRDialogProps) {
  const { t } = useTranslation(['taskReview', 'tasks', 'common']);
  const [isMerging, setIsMerging] = useState(false);
  const [progress, setProgress] = useState<MergePRProgress | null>(null);
  const [result, setResult] = useState<WorktreeMergePRResult | null>(null);

  useEffect(() => {
    if (open) {
      setIsMerging(false);
      setProgress(null);
      setResult(null);
    }
  }, [open]);

  // Steps of the merge as the main process reports them
  useEffect(() => {
    if (!open) return;
    return window.electronAPI.onMergePRProgress((taskId, next) => {
      if (taskId === task.id) setProgress(next);
    });
  }, [open, task.id]);

  const handleMerge = async () => {
    setIsMerging(true);
    setProgress(null);
    setResult(null);
    try {
      setResult(await onMergePR({}));
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : undefined });
    } finally {
      setIsMerging(false);
    }
  };

  const resolvedCount = result?.conflictedFiles?.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !isMerging && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('taskReview:mergePr.title')}</DialogTitle>
          <DialogDescription>{t('taskReview:mergePr.description', { taskTitle: task.title })}</DialogDescription>
        </DialogHeader>

        {/* Merged */}
        {result?.success && (
          <>
            <div className="mt-4 space-y-2 text-sm">
              <p className="text-foreground">
                {result.alreadyMerged
                  ? t('taskReview:mergePr.success.alreadyMerged')
                  : result.targetBranch
                    ? t('taskReview:mergePr.success.merged', { branch: result.targetBranch })
                    : t('taskReview:mergePr.success.mergedNoBranch')}
              </p>
              {resolvedCount > 0 && (
                <p className="text-(--nav-label-color)">{t('taskReview:mergePr.success.conflictsResolved', { count: resolvedCount })}</p>
              )}
              {result.summary && (
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-(--nav-label-color)">{result.summary}</p>
              )}
            </div>
            <DialogFooter>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                {t('common:buttons.close')}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Failed */}
        {result && !result.success && (
          <>
            <div className="mt-4 space-y-2 text-sm">
              <p className="whitespace-pre-wrap text-destructive">{result.error || t('taskReview:mergePr.errors.unknown')}</p>
              {result.summary && (
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-(--nav-label-color)">{result.summary}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isMerging}>
                {t('common:buttons.cancel')}
              </Button>
              <Button size="sm" onClick={handleMerge} disabled={isMerging}>
                {t('taskReview:mergePr.actions.retry')}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Form */}
        {!result && (
          <>
            <div className="-mx-6 mt-2 min-h-0 overflow-y-auto px-6">
              <SettingsRows>
                {/* A long branch name is cut short (full name on hover) so the label stays on one line */}
                <SettingsRow label={<span className="whitespace-nowrap">{t('taskReview:pr.labels.sourceBranch')}</span>}>
                  <span
                    className="block max-w-72 truncate font-mono text-xs text-(--nav-label-color)"
                    title={worktreeStatus?.branch}
                  >
                    {worktreeStatus?.branch || t('taskReview:pr.labels.unknown')}
                  </span>
                </SettingsRow>
                {task.metadata?.prUrl && (
                  <SettingsRow label={t('taskReview:mergePr.labels.pullRequest')}>
                    <ExternalLink onClick={() => void window.electronAPI.openExternal(task.metadata!.prUrl!)} className="break-all text-xs">
                      {task.metadata.prUrl.replace(/^https:\/\/github\.com\//, '')}
                    </ExternalLink>
                  </SettingsRow>
                )}
              </SettingsRows>
              <p className="mt-3 text-sm text-(--nav-label-color)">{t('taskReview:mergePr.hints.merge')}</p>
            </div>

            {isMerging && (
              <p className="flex items-center gap-2 text-sm text-(--nav-label-color)">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                {progress
                  ? t(`taskReview:mergePr.steps.${progress.step}`, progress.params ?? {})
                  : t('taskReview:mergePr.steps.checking')}
              </p>
            )}

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isMerging}>
                {t('common:buttons.cancel')}
              </Button>
              <Button size="sm" onClick={handleMerge} disabled={isMerging}>
                {isMerging ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('taskReview:mergePr.actions.merging')}
                  </>
                ) : (
                  t('taskReview:mergePr.actions.merge')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
