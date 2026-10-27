import { AlertTriangle, CheckCircle2, GitMerge, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Task } from '../../shared/types';
import { cn } from '../lib/utils';

/** The same merge state on the board and in task details; progress is never a completion claim. */
export function TaskMergeStatus({ task, compact = false }: { task: Task; compact?: boolean }) {
  const { t } = useTranslation('tasks');
  if (task.status !== 'human_review' && task.status !== 'done') return null;
  const progress = task.metadata?.autoMergeProgress;
  const record = task.metadata?.autoMerge;
  const blocked = task.metadata?.autoMergeBlocked;
  // A completed write wins over older saved progress, including records from an older app build.
  const finished = record && (!progress || Date.parse(record.at) >= Date.parse(progress.at));
  const failed = !finished && blocked && (!progress || Date.parse(blocked.at) >= Date.parse(progress.at));
  const phase = finished ? record.revertedAt ? 'reverted' : 'merged' : failed ? 'blocked' : progress?.phase;
  if (!phase) return null;
  const active = phase !== 'merged' && phase !== 'reverted' && phase !== 'blocked' && phase !== 'interrupted';
  const branch = (finished ? record.branch : progress?.targetBranch) ?? t('autonomous.progress.target');
  const label = phase === 'resolving' && progress?.conflictCount
    ? t('autonomous.progress.resolvingCount', { count: progress.conflictCount, branch })
    : t(`autonomous.progress.${phase}`, { branch });
  const Icon = active ? Loader2 : phase === 'merged' ? CheckCircle2 : phase === 'blocked' || phase === 'interrupted' ? AlertTriangle : GitMerge;
  const at = finished ? record.revertedAt ?? record.at : failed ? blocked.at : progress?.at;
  const warning = phase === 'blocked' || phase === 'interrupted' || !!(finished && record.pushError);
  return (
    <section role="status" aria-label={t('autonomous.progress.title')} aria-live="polite"
      className={cn(compact ? 'mt-1.5' : 'rounded-lg border border-border bg-card/60 p-4', warning ? 'text-warning' : phase === 'merged' ? 'text-success' : 'text-primary')}>
      <p className="flex items-start gap-1.5 text-xs font-medium wrap-anywhere">
        <Icon aria-hidden="true" className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', active && 'animate-spin motion-reduce:animate-none')} />
        <span>{label}{finished && record.pushError && compact ? ` · ${t('autonomous.progress.pushFailed')}` : ''}</span>
      </p>
      {!compact && <div className="mt-2 space-y-1 text-xs text-muted-foreground">
        {active && <p>{t('autonomous.progress.workingHelp')}</p>}
        {phase === 'interrupted' && <p>{t('autonomous.progress.interruptedHelp')}</p>}
        {phase === 'blocked' && <p className="whitespace-pre-wrap break-words">{blocked?.message}</p>}
        {finished && <p className="font-mono break-all">{record.sha.slice(0, 8)}</p>}
        {finished && record.pushError ? <p className="text-warning break-words">{t('autonomous.panel.pushFailed', { error: record.pushError })}</p>
          : finished && record.pushed ? <p>{t('autonomous.panel.pushed', { branch })}</p> : null}
        {at && <p>{t('autonomous.progress.updated')} <time dateTime={at}>{new Date(at).toLocaleString()}</time></p>}
      </div>}
    </section>
  );
}
