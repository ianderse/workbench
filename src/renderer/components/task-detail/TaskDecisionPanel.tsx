import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { loadTasks } from '../../stores/task-store';
import { taskNumber } from '../../../shared/utils/queue-grooming';
import {
  getDecisionQuestion,
  getDecisionSuggestion,
  initialDecisionText,
  isAwaitingDecision,
  resolveDecisionText,
  type DecisionAction, type DecisionData,
} from '../../../shared/utils/decision-tickets';
import type { Task } from '../../../shared/types';

interface TaskDecisionPanelProps {
  task: Task;
}

/**
 * "Your decision": where the person answers a ticket that needs a decision. Make tickets turns the
 * answer into implementation tickets (one model call), Not now saves the note and keeps the ticket
 * in Planning, Reject archives it with the reason. Shown above the description.
 */
export function TaskDecisionPanel({ task }: TaskDecisionPanelProps) {
  const { t } = useTranslation('tasks');
  const [text, setText] = useState(() => initialDecisionText(task.metadata));
  const [generated, setGenerated] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState<DecisionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DecisionData | null>(null);

  // The ticket is decided (by this panel or before): only what this panel just did stays visible
  const awaiting = isAwaitingDecision(task.metadata);
  if (!awaiting && !result) return null;

  const suggestion = getDecisionSuggestion(task.metadata) || generated;
  const question = getDecisionQuestion(task.metadata, task.description) || t('queueGrooming.decision.questionFallback');

  const submit = async (action: DecisionAction) => {
    // An empty answer accepts the suggestion; what the person wrote always wins
    const answer = action === 'tickets' ? resolveDecisionText(text, suggestion) : text;
    if (action === 'tickets' && !answer) {
      setError(t('queueGrooming.decision.needsText'));
      return;
    }
    setBusy(action);
    setError(null);
    setResult(null);
    try {
      const response = await window.electronAPI.decideTicket(task.projectId, task.id, action, answer);
      if (!response.success || !response.data) {
        setError(t('queueGrooming.decision.failed', { error: response.error ?? '' }));
        return;
      }
      setResult(response.data);
      if (response.data.outcome !== 'none') await loadTasks(task.projectId, { forceRefresh: true });
    } catch (e) {
      setError(t('queueGrooming.decision.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const response = await window.electronAPI.suggestDecision(task.projectId, task.id);
      const value = response.data?.suggestion;
      if (!response.success || !value) {
        setError(t('queueGrooming.decision.suggestFailed', { error: response.error ?? '' }));
        return;
      }
      setGenerated(value);
      setText((current) => (current.trim() ? current : value));
      await loadTasks(task.projectId, { forceRefresh: true });
    } catch (e) {
      setError(t('queueGrooming.decision.suggestFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSuggesting(false);
    }
  };

  const list = (result?.created ?? [])
    .map((c) => t(c.queued ? 'queueGrooming.decision.ticketQueued' : 'queueGrooming.decision.ticketPlanned', { number: taskNumber(c.taskId) }))
    .join(', ');
  const done = !!result && result.outcome !== 'none';

  return (
    <section aria-label={t('queueGrooming.decision.title')} className="rounded-lg border border-warning/50 bg-warning/5 p-4">
      <h3 className="text-sm font-medium text-foreground">{t('queueGrooming.decision.title')}</h3>
      <p className="mt-2 text-xs font-medium text-(--nav-label-color)">{t('queueGrooming.decision.question')}</p>
      <p className="text-sm text-foreground wrap-anywhere">{question}</p>

      {!done && suggestion && (
        <div className="mt-3">
          <p className="text-xs font-medium text-(--nav-label-color)">{t('queueGrooming.decision.suggested')}</p>
          <p className="text-sm text-foreground wrap-anywhere">{suggestion}</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null || text === suggestion}
            onClick={() => setText(suggestion)}
            className="-ml-2 mt-1 h-7"
          >
            {t('queueGrooming.decision.useSuggestion')}
          </Button>
        </div>
      )}

      {!done && (
        <>
          <label htmlFor={`decision-${task.id}`} className="mt-3 block text-xs font-medium text-(--nav-label-color)">
            {t('queueGrooming.decision.label')}
          </label>
          <textarea
            id={`decision-${task.id}`}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('queueGrooming.decision.placeholder')}
            spellCheck
            disabled={busy !== null || suggesting}
            className={cn(
              'mt-1 block w-full resize-y rounded-md border border-border bg-transparent px-3 py-2',
              'text-sm leading-relaxed text-foreground placeholder:text-(--field-placeholder)',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60'
            )}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy !== null || suggesting} onClick={() => void submit('tickets')} className="gap-1.5">
              {busy === 'tickets' && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('queueGrooming.decision.makeTickets')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void submit('defer')}>
              {t('queueGrooming.decision.notNow')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void submit('reject')}>
              {t('queueGrooming.decision.reject')}
            </Button>
            {!suggestion && (
              <Button size="sm" variant="outline" disabled={busy !== null || suggesting} onClick={() => void suggest()} className="gap-1.5">
                {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {t('queueGrooming.decision.suggest')}
              </Button>
            )}
          </div>
        </>
      )}

      {suggesting && (
        <p role="status" className="mt-3 text-xs text-(--nav-label-color)">
          {t('queueGrooming.decision.suggesting')}
        </p>
      )}
      {busy === 'tickets' && (
        <p role="status" className="mt-3 text-xs text-(--nav-label-color)">
          {t('queueGrooming.decision.working')}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs font-medium text-destructive wrap-anywhere">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="mt-3 space-y-2">
          <p className="text-sm font-medium text-foreground">
            {result.outcome === 'none'
              ? t('queueGrooming.decision.noTickets')
              : result.outcome === 'tickets'
                ? t('queueGrooming.decision.created', { list })
                : t('queueGrooming.decision.deferredNote')}
          </p>
          {result.decisionRecord && (
            <div>
              <p className="text-xs font-medium text-(--nav-label-color)">{t('queueGrooming.decision.recordTitle')}</p>
              <p className="whitespace-pre-wrap text-sm text-foreground wrap-anywhere">{result.decisionRecord}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
