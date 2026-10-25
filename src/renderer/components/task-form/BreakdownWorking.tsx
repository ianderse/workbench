/**
 * BreakdownWorking - the "working" step of Break into tasks: spinner, time elapsed, the model, what
 * it is doing right now, and a hint when other tasks share the model server.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useTaskStore } from '../../stores/task-store';
import type { RunProgress } from '../../../shared/utils/run-progress';

/** mm:ss (hh:mm:ss from an hour) */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

interface BreakdownWorkingProps {
  progress: RunProgress | null;
}

export function BreakdownWorking({ progress }: BreakdownWorkingProps) {
  const { t } = useTranslation(['tasks']);
  // A number, so the selector result is stable
  const running = useTaskStore((state) => state.tasks.filter((task) => task.status === 'in_progress' || task.status === 'ai_review').length);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const tokens = progress?.tokens ?? 0;
  const tokenText = tokens.toLocaleString();
  let activity = t('tasks:breakdown.progress.starting');
  if (progress?.stage === 'reading') {
    activity = progress.file
      ? t('tasks:breakdown.progress.reading', { file: progress.file })
      : t('tasks:breakdown.progress.readingProject');
  } else if (progress?.stage === 'writing') {
    activity = tokens > 0 ? t('tasks:breakdown.progress.writingTokens', { tokens: tokenText }) : t('tasks:breakdown.progress.writing');
  } else if (progress?.stage === 'thinking') {
    activity = tokens > 0 ? t('tasks:breakdown.progress.thinkingTokens', { tokens: tokenText }) : t('tasks:breakdown.progress.thinking');
  }

  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center" role="status">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      <p className="text-sm text-foreground">{t('tasks:breakdown.working')}</p>
      <p className="text-xs text-(--nav-label-color)">{t('tasks:breakdown.workingHint')}</p>
      <p className="text-xs tabular-nums text-(--nav-label-color)">
        {t('tasks:breakdown.progress.elapsed', { time: formatElapsed(now - startedAt) })}
        {progress?.model ? ` · ${progress.model}` : ''}
      </p>
      <p className="max-w-full text-sm text-foreground wrap-anywhere">{activity}</p>
      {running > 0 && (
        <p className="text-xs text-(--nav-label-color)">{t('tasks:breakdown.progress.sharing', { count: running })}</p>
      )}
    </div>
  );
}
