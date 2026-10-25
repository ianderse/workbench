import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { taskNumber } from '../../shared/utils/queue-grooming';
import type { Task } from '../../shared/types';
import { isBreakdownProposal, type QueueProposal, type QueueUndoEntry, type StructuralProposal } from '../../shared/types/queue-grooming';
import { useBreakdownReviewStore } from '../stores/breakdown-review-store';

interface QueueUpdatesPanelProps {
  projectId: string;
  tasks: Task[];
}

/**
 * Compact panel above the board: the changes a merged task proposes for the tickets in Planning and
 * the Queue (archive an obsolete or duplicate ticket, add a task). Each one is applied or dismissed
 * here; notes on single tickets are applied on their own and shown on the card. Hidden when nothing
 * is proposed. Below it, "Recent automatic changes" lists what autonomous mode applied on its own, each
 * with Undo.
 */
export function QueueUpdatesPanel({ projectId, tasks }: QueueUpdatesPanelProps) {
  const { t } = useTranslation('tasks');
  const [proposals, setProposals] = useState<QueueProposal[]>([]);
  const [undoEntries, setUndoEntries] = useState<QueueUndoEntry[]>([]);
  const [undoExpanded, setUndoExpanded] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await window.electronAPI.listQueueProposals(projectId);
    if (result.success) setProposals(result.data ?? []);
    const undo = await window.electronAPI.listQueueUndo(projectId);
    if (undo.success) setUndoEntries(undo.data ?? []);
  }, [projectId]);

  // Read once when the board opens, then whenever the main process says proposals changed
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    return window.electronAPI.onQueueProposalsChanged((changedProject) => {
      if (changedProject === projectId) void loadRef.current();
    });
  }, [projectId]);

  const titleOf = (id: string) => tasks.find((task) => task.id === id)?.title ?? t('queueGrooming.unknownTask');

  const run = async (proposal: QueueProposal, action: 'apply' | 'dismiss') => {
    setBusyId(proposal.id);
    setError(null);
    try {
      const result =
        action === 'apply'
          ? await window.electronAPI.applyQueueProposal(projectId, proposal.id)
          : await window.electronAPI.dismissQueueProposal(projectId, proposal.id);
      if (!result.success) setError(t('queueGrooming.applyFailed', { error: result.error ?? '' }));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const undoChange = async (entry: QueueUndoEntry) => {
    setBusyId(entry.id);
    setError(null);
    try {
      const result = await window.electronAPI.undoQueueChange(projectId, entry.id);
      if (!result.success) setError(t('autonomous.recentChanges.undoFailed', { error: result.error ?? '' }));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  if (proposals.length === 0 && undoEntries.length === 0) return null;

  const describeApplied = (proposal: StructuralProposal): string => {
    switch (proposal.kind) {
      case 'obsolete':
        return t('autonomous.recentChanges.obsolete', { title: titleOf(proposal.taskId) });
      case 'duplicate':
        return t('autonomous.recentChanges.duplicate', { title: titleOf(proposal.taskId), kept: titleOf(proposal.duplicateOf) });
      case 'newTask':
        return t('autonomous.recentChanges.newTask', { title: proposal.title });
      case 'split':
        return t('autonomous.recentChanges.split', { title: titleOf(proposal.taskId), count: proposal.pieces.length });
    }
  };

  const describe = (proposal: StructuralProposal): string => {
    switch (proposal.kind) {
      case 'obsolete':
        return t('queueGrooming.obsolete', { title: titleOf(proposal.taskId) });
      case 'duplicate':
        return t('queueGrooming.duplicate', { title: titleOf(proposal.taskId), kept: titleOf(proposal.duplicateOf) });
      case 'newTask':
        return t('queueGrooming.newTask', { title: proposal.title });
      case 'split':
        return t('queueGrooming.split', { title: titleOf(proposal.taskId), count: proposal.pieces.length });
    }
  };

  return (
    <>
    {proposals.length > 0 && (
    <section
      aria-label={t('queueGrooming.panelTitle', { count: proposals.length })}
      className="mx-6 mt-2 rounded-lg border border-border bg-card/60"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t('queueGrooming.panelToggle')}
      >
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {t('queueGrooming.panelTitle', { count: proposals.length })}
      </button>
      {expanded && (
        <ul className="divide-y divide-border border-t border-border">
          {proposals.map((proposal) => isBreakdownProposal(proposal) ? (
            <li key={proposal.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground wrap-anywhere">
                  {proposal.kind === 'breakdown'
                    ? t('queueGrooming.breakdownReady', { count: proposal.breakdown.tasks.length })
                    : t('queueGrooming.breakdownFailed', { error: proposal.error })}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-(--nav-label-color) wrap-anywhere">{proposal.prompt}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {proposal.kind === 'breakdown' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === proposal.id}
                    onClick={() =>
                      useBreakdownReviewStore.getState().request({
                        projectId,
                        proposalId: proposal.id,
                        prompt: proposal.prompt,
                        breakdown: proposal.breakdown,
                      })
                    }
                  >
                    {t('queueGrooming.review')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busyId === proposal.id} onClick={() => void run(proposal, 'dismiss')}>
                  {t('queueGrooming.dismiss')}
                </Button>
              </div>
            </li>
          ) : (
            <li key={proposal.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground wrap-anywhere">{describe(proposal)}</p>
                <p className="mt-0.5 text-xs text-(--nav-label-color) wrap-anywhere">
                  {proposal.kind === 'split'
                    ? t('queueGrooming.splitIntro', { number: taskNumber(proposal.fromTaskId) })
                    : t('queueGrooming.intro', { number: taskNumber(proposal.fromTaskId) })}
                  {proposal.reason ? `: ${proposal.reason}` : ''}
                </p>
                {proposal.kind === 'split' && (
                  <p className="mt-0.5 text-xs text-(--nav-label-color) wrap-anywhere">
                    {t('queueGrooming.splitPieces', { titles: proposal.pieces.map((piece) => piece.title).join(', ') })}
                  </p>
                )}
                {proposal.kind === 'newTask' && proposal.dependsOn.length > 0 && (
                  <p className="mt-0.5 text-xs text-(--nav-label-color) wrap-anywhere">
                    {t('queueGrooming.waitsFor', { titles: proposal.dependsOn.map(titleOf).join(', ') })}
                  </p>
                )}
              </div>
              <div className={cn('flex shrink-0 items-center gap-1')}>
                <Button size="sm" variant="ghost" disabled={busyId === proposal.id} onClick={() => void run(proposal, 'apply')}>
                  {t('queueGrooming.apply')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busyId === proposal.id} onClick={() => void run(proposal, 'dismiss')}>
                  {t('queueGrooming.dismiss')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
    )}
    {undoEntries.length > 0 && (
      <section
        aria-label={t('autonomous.recentChanges.title', { count: undoEntries.length })}
        className="mx-6 mt-2 rounded-lg border border-border bg-card/60"
      >
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-foreground"
          onClick={() => setUndoExpanded((value) => !value)}
          aria-expanded={undoExpanded}
          aria-label={t('autonomous.recentChanges.toggle')}
        >
          {undoExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {t('autonomous.recentChanges.title', { count: undoEntries.length })}
        </button>
        {undoExpanded && (
          <ul className="divide-y divide-border border-t border-border">
            {[...undoEntries].reverse().map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground wrap-anywhere">{describeApplied(entry.proposal)}</p>
                  <p className="mt-0.5 text-xs text-(--nav-label-color) wrap-anywhere">
                    {entry.proposal.kind === 'split'
                      ? t('queueGrooming.splitIntro', { number: taskNumber(entry.proposal.fromTaskId) })
                      : t('queueGrooming.intro', { number: taskNumber(entry.proposal.fromTaskId) })}
                    {entry.proposal.reason ? `: ${entry.proposal.reason}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="ghost" className="shrink-0" disabled={busyId === entry.id} onClick={() => void undoChange(entry)}>
                  {t('autonomous.recentChanges.undo')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && proposals.length === 0 && (
          <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </section>
    )}
    </>
  );
}
