import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { buttonVariants } from './ui/button';

interface StartOverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy?: boolean;
}

/**
 * Confirmation before a task starts over: its worktree and branch are discarded (a backup branch
 * keeps the work) and the run begins from a clean slate.
 */
export function StartOverDialog({ open, onOpenChange, onConfirm, busy = false }: StartOverDialogProps) {
  const { t } = useTranslation('tasks');
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog is portalled, but React events still bubble to the card or row it was opened from */}
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('startOverDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>{t('startOverDialog.description')}</p>
              <p className="rounded-xl bg-segment-track px-4 py-3 text-foreground">{t('startOverDialog.backupNote')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('startOverDialog.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            className={buttonVariants({ variant: 'destructive', size: 'sm' })}
          >
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('startOverDialog.starting')}
              </>
            ) : (
              t('startOverDialog.confirm')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
