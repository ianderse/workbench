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
import { SettingsRow, SettingsRows } from '../../settings/SettingsRow';
import type { Task, WorktreeLocalMergeResult, WorktreeStatus } from '../../../../shared/types';

interface LocalMergeDialogProps {
  open: boolean;
  task: Task;
  worktreeStatus: WorktreeStatus | null;
  onOpenChange: (open: boolean) => void;
  onMerge: () => Promise<WorktreeLocalMergeResult>;
}

/**
 * Dialog for merging a task's branch into the base branch chosen for it with plain git, in the
 * project. Nothing is pushed and no pull request is involved.
 */
export function LocalMergeDialog({ open, task, worktreeStatus, onOpenChange, onMerge }: LocalMergeDialogProps) {
  const { t } = useTranslation(['taskReview', 'tasks', 'common']);
  const [isMerging, setIsMerging] = useState(false);
  const [result, setResult] = useState<WorktreeLocalMergeResult | null>(null);

  useEffect(() => {
    if (open) {
      setIsMerging(false);
      setResult(null);
    }
  }, [open]);

  const handleMerge = async () => {
    setIsMerging(true);
    setResult(null);
    try {
      setResult(await onMerge());
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : undefined });
    } finally {
      setIsMerging(false);
    }
  };

  const sourceBranch = worktreeStatus?.branch;
  const targetBranch = worktreeStatus?.baseBranch;

  return (
    <Dialog open={open} onOpenChange={(next) => !isMerging && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('taskReview:localMerge.title')}</DialogTitle>
          <DialogDescription>{t('taskReview:localMerge.description', { taskTitle: task.title })}</DialogDescription>
        </DialogHeader>

        {/* Merged */}
        {result?.success && (
          <>
            <div className="mt-4 text-sm">
              <p className="text-foreground">
                {result.alreadyMerged
                  ? t('taskReview:localMerge.success.alreadyMerged', { source: result.sourceBranch, target: result.targetBranch })
                  : result.sourceBranch && result.targetBranch
                    ? t('taskReview:localMerge.success.merged', { source: result.sourceBranch, target: result.targetBranch })
                    : t('taskReview:localMerge.success.mergedNoBranch')}
              </p>
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
              <p className="whitespace-pre-wrap text-destructive">{result.error || t('taskReview:localMerge.errors.unknown')}</p>
              {result.conflictedFiles && result.conflictedFiles.length > 0 && (
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-(--nav-label-color)">
                  {t('taskReview:localMerge.errors.conflictedFiles', { files: result.conflictedFiles.join(', ') })}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isMerging}>
                {t('common:buttons.cancel')}
              </Button>
              <Button size="sm" onClick={handleMerge} disabled={isMerging}>
                {t('taskReview:localMerge.actions.retry')}
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
                  <span className="block max-w-72 truncate font-mono text-xs text-(--nav-label-color)" title={sourceBranch}>
                    {sourceBranch || t('taskReview:pr.labels.unknown')}
                  </span>
                </SettingsRow>
                <SettingsRow label={<span className="whitespace-nowrap">{t('taskReview:pr.labels.targetBranch')}</span>}>
                  <span className="block max-w-72 truncate font-mono text-xs text-(--nav-label-color)" title={targetBranch}>
                    {targetBranch || t('taskReview:pr.labels.unknown')}
                  </span>
                </SettingsRow>
                {worktreeStatus?.exists && (
                  <SettingsRow label={t('taskReview:pr.labels.commits')}>
                    <span className="text-sm tabular-nums text-(--nav-label-color)">{worktreeStatus.commitCount || 0}</span>
                  </SettingsRow>
                )}
                {worktreeStatus?.exists && (
                  <SettingsRow label={t('taskReview:pr.labels.changes')}>
                    <span className="flex gap-2 text-sm tabular-nums">
                      <span className="text-success">+{worktreeStatus.additions || 0}</span>
                      <span className="text-destructive">-{worktreeStatus.deletions || 0}</span>
                    </span>
                  </SettingsRow>
                )}
                <p className="pt-1 text-xs text-(--nav-label-color)">{t('taskReview:localMerge.hints.merge')}</p>
              </SettingsRows>
            </div>

            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isMerging}>
                {t('common:buttons.cancel')}
              </Button>
              <Button size="sm" onClick={handleMerge} disabled={isMerging}>
                {isMerging ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('taskReview:localMerge.actions.merging')}
                  </>
                ) : (
                  t('taskReview:localMerge.actions.merge')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
