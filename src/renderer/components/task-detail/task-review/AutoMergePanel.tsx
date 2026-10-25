import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Undo2 } from 'lucide-react';
import { Button, buttonVariants } from '../../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import type { Task } from '../../../../shared/types';
import type { AutonomousRevertPreview } from '../../../../shared/types/autonomous';

interface AutoMergePanelProps {
  task: Task;
}

/**
 * Shown in Human Review for a task autonomous mode merged on its own: where it went, the push
 * result and "Revert this task" (asks first, listing later automatic merges that depend on it).
 * Moving the task to Done is the sign-off; nothing is merged again.
 */
export function AutoMergePanel({ task }: AutoMergePanelProps) {
  const { t } = useTranslation('tasks');
  const record = task.metadata?.autoMerge;
  const [preview, setPreview] = useState<AutonomousRevertPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!record) return null;

  if (record.revertedAt) {
    return (
      <section role="region" aria-label={t('autonomous.panel.title')} className="rounded-lg border border-border bg-card/60 p-4">
        <p className="text-sm text-foreground">{t('autonomous.panel.revertedNote', { branch: record.branch })}</p>
      </section>
    );
  }

  const openRevert = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.previewAutoMergeRevert(task.id, task.projectId);
      if (result.success) setPreview(result.data ?? { dependents: [] });
      else setError(t('autonomous.panel.revertFailed', { error: result.error ?? '' }));
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.revertAutoMerge(task.id, task.projectId);
      if (!result.success) setError(t('autonomous.panel.revertFailed', { error: result.error ?? '' }));
      else setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const followUpId = task.metadata?.autoMergeFollowUpTaskId;

  return (
    <section role="region" aria-label={t('autonomous.panel.title')} className="rounded-lg border border-border bg-card/60 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{t('autonomous.panel.title')}</h3>
          <p className="mt-1 text-sm text-foreground wrap-anywhere">
            {t('autonomous.panel.description', { branch: record.branch, sha: record.sha.slice(0, 8) })}
          </p>
          {record.pushError ? (
            <p className="mt-1 text-xs text-warning wrap-anywhere">{t('autonomous.panel.pushFailed', { error: record.pushError })}</p>
          ) : record.pushed ? (
            <p className="mt-1 text-xs text-(--nav-label-color)">{t('autonomous.panel.pushed', { branch: record.branch })}</p>
          ) : null}
          <p className="mt-1 text-xs text-(--nav-label-color) wrap-anywhere">
            {t('autonomous.panel.requestChangesNote', { branch: record.branch })}
          </p>
          {followUpId && <p className="mt-1 text-xs text-(--nav-label-color) wrap-anywhere">{t('autonomous.panel.followUp', { id: followUpId })}</p>}
        </div>
        <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={() => void openRevert()} disabled={busy}>
          {busy && !preview ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
          {busy && !preview ? t('autonomous.panel.reverting') : t('autonomous.panel.revert')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive wrap-anywhere">
          {error}
        </p>
      )}

      <AlertDialog open={preview !== null} onOpenChange={(open) => !open && !busy && setPreview(null)}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('autonomous.panel.revertTitle', { title: task.title })}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>{t('autonomous.panel.revertDescription', { branch: record.branch })}</p>
                {preview && preview.dependents.length > 0 && (
                  <div>
                    <p>{t('autonomous.panel.revertDependents')}</p>
                    <ul className="mt-1 list-disc pl-5 text-foreground">
                      {preview.dependents.map((dependent) => (
                        <li key={dependent.id} className="wrap-anywhere">{dependent.title}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('autonomous.panel.revertCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void revert();
              }}
              disabled={busy}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {busy ? t('autonomous.panel.reverting') : t('autonomous.panel.revertConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
