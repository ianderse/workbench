import { useTranslation } from 'react-i18next';
import { TaskLogs } from './TaskLogs';
import { formatShortRelativeTime } from '../../lib/utils';
import type { ArchivedTaskRun } from '../../../shared/types';

interface PreviousRunsProps {
  /** The runs the task was started over from, oldest first */
  runs: ArchivedTaskRun[];
  /** Which of them are open, by run index (none at first) */
  openRuns: number[];
  onToggleRun: (index: number) => void;
}

/**
 * The runs a task was started over from, oldest first so the newest sits closest to the
 * current run below: one closed "Logs <when> ago" dropdown each, holding that run's steps
 * exactly as the current run's Logs show them. Nothing is shown for a task that was never
 * started over.
 */
export function PreviousRuns({ runs, openRuns, onToggleRun }: PreviousRunsProps) {
  const { t } = useTranslation('tasks');
  if (runs.length === 0) return null;

  return (
    <div>
      <h3 className="mb-1 text-sm text-foreground">{t('previousRuns.title')}</h3>
      <p className="mb-3 text-sm text-(--nav-label-color)">{t('previousRuns.description')}</p>

      <div className="space-y-1">
        {runs.map((run) => (
          <TaskLogs
            key={run.index}
            phaseLogs={run.logs}
            runPhases={run.phases}
            isSettled
            title={t('logs.previousRunTitle', { time: formatShortRelativeTime(run.archivedAt) })}
            isExpanded={openRuns.includes(run.index)}
            onToggle={() => onToggleRun(run.index)}
          />
        ))}
      </div>
    </div>
  );
}
