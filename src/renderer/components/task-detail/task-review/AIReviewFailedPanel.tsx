import type { Task } from '../../../../shared/types';
import { HumanWorkPanel } from './HumanWorkPanel';
import { useTranslation } from 'react-i18next';
import { formatFindingLocation } from '../../../../shared/utils/ai-review-loop';
import type { ClaudeRunInfo } from '../../../../shared/types/claude-code';

interface AIReviewFailedPanelProps {
  claudeRun: ClaudeRunInfo | undefined;
  task?: Task;
}

/**
 * Shown at the top of a task in Human Review when it still failed AI review after its last round:
 * why it fails, the findings still open and how each round went (progress or going in circles).
 */
export function AIReviewFailedPanel({ claudeRun, task }: AIReviewFailedPanelProps) {
  const { t } = useTranslation('tasks');
  const verdict = claudeRun?.reviewVerdict;
  const failure = verdict?.failure;
  if (!verdict || verdict.status !== 'failed' || !failure) return null;

  const humanOnly = failure.openFindings.length > 0 && failure.failingChecks.length === 0 && failure.openFindings.every((finding) => finding.requiresHuman || task?.metadata?.humanWork?.items.some((item) => item.finding.description === finding.description));
  const title = humanOnly ? t('humanWork.needsHuman') : t('aiReviewFailed.title', { count: verdict.rounds });
  if (humanOnly && task) return <>
    <HumanWorkPanel task={task} findings={failure.openFindings} />
    <details className="rounded-lg border p-3 text-xs"><summary>{t('humanWork.technicalReview')}</summary><p className="mt-2 whitespace-pre-wrap wrap-anywhere">{failure.reason}</p><ul className="mt-2 space-y-1">{failure.roundLines.map(line => <li key={line}>{line}</li>)}</ul></details>
  </>;
  return (
    <section
      role="region"
      aria-label={title}
      className="rounded-lg border border-destructive/40 bg-destructive/5 p-4"
    >
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="mt-1 text-sm text-foreground wrap-anywhere">{failure.reason}</p>

      {failure.openFindings.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-(--nav-label-color)">{t('aiReviewFailed.openFindings')}</h4>
          <ul className="mt-1 space-y-1">
            {failure.openFindings.map((finding, i) => {
              const where = formatFindingLocation(finding);
              return (
                <li key={`${i}-${finding.description}`} className="text-sm text-foreground wrap-anywhere">
                  <span className="text-xs uppercase text-(--nav-label-color)">{finding.severity}</span>
                  {where && <code className="ml-2 text-xs">{where}</code>}
                  <span className="ml-2">{finding.description}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {failure.failingChecks.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-(--nav-label-color)">{t('aiReviewFailed.failingChecks')}</h4>
          <p className="mt-1 text-sm text-foreground wrap-anywhere">{failure.failingChecks.join(', ')}</p>
        </div>
      )}

      {task && failure.openFindings.length > 0 && <HumanWorkPanel task={task} findings={failure.openFindings} />}

      {failure.roundLines.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-medium text-(--nav-label-color)">{t('aiReviewFailed.progress')}</h4>
          <ul className="mt-1 space-y-0.5">
            {failure.roundLines.map((line) => (
              <li key={line} className="text-sm text-foreground">{line}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
