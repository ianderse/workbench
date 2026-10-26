import { useTranslation } from 'react-i18next';
import { useTaskStore } from '../../../stores/task-store';
import type { Task } from '../../../../shared/types';
import { deriveSpecReviewNext, specReviewNextKey } from '../../../../shared/utils/spec-review';
import { specReviewNextText } from '../../../lib/spec-review-next';

interface SpecReviewPanelProps {
  task: Task;
}

/** Whether the panel has a report to show for a task */
export function shouldShowSpecReview(task: Task): boolean {
  return !!task.metadata?.specReview && task.status === 'human_review' && !!task.claudeRun?.specReview;
}

/**
 * Top of a Spec review ticket in Human Review: whether the spec is complete as written, how each
 * section stands, and the gaps (each with the spec section and the evidence for it).
 */
export function SpecReviewPanel({ task }: SpecReviewPanelProps) {
  const { t } = useTranslation('tasks');
  const report = task.claudeRun?.specReview;
  const ref = task.metadata?.specReview;
  // A number, so the selector result is stable
  const created = useTaskStore((state) =>
    ref ? state.tasks.filter((x) => x.metadata?.specBatch?.id === ref.batchId && x.metadata.specBatch.round === ref.round + 1).length : 0
  );
  const nextKey = useTaskStore((state) =>
    ref ? specReviewNextKey(deriveSpecReviewNext(state.tasks, ref, report?.gaps.length, report?.checksObserved)) : ''
  );
  if (!report || !ref) return null;

  const gaps = report.gaps.length;
  const headline = gaps === 0
    ? report.complete ? t('specReview.complete') : t('specReview.unverified')
    : created > 0
      ? t('specReview.gapsCreated', { gaps, created })
      : t('specReview.gapsOpen', { count: gaps });

  return (
    <section role="region" aria-label={t('specReview.title')} className="rounded-lg border border-border bg-card/60 p-4">
      <h3 className="text-sm font-medium text-foreground">{t('specReview.title')}</h3>
      <p className="mt-2 text-base font-medium leading-snug text-foreground wrap-anywhere">{headline}</p>
      {nextKey && nextKey !== 'unverified' && <p className="mt-1 text-sm font-medium text-(--nav-label-color)">{specReviewNextText(nextKey, t)}</p>}
      {report.summary && <p className="mt-1 text-sm text-foreground wrap-anywhere">{report.summary}</p>}

      {report.sections.length > 0 && (
        <table className="mt-3 w-full table-fixed text-left text-xs">
          <thead>
            <tr className="text-(--nav-label-color)">
              <th className="w-2/5 py-1 pr-2 font-medium">{t('specReview.section')}</th>
              <th className="w-1/6 py-1 pr-2 font-medium">{t('specReview.status')}</th>
              <th className="py-1 font-medium">{t('specReview.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {report.sections.map((section, i) => (
              <tr key={`${i}-${section.section}`} className="align-top border-t border-border">
                <td className="py-1 pr-2 text-foreground wrap-anywhere">{section.section}</td>
                <td className="py-1 pr-2 text-foreground">{t(`specReview.statuses.${section.status}`)}</td>
                <td className="py-1 text-(--nav-label-color) wrap-anywhere">{section.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {gaps > 0 && (
        <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
          <h4 className="text-xs font-medium text-foreground">{t('specReview.gaps')}</h4>
          <ul className="mt-1 space-y-2">
            {report.gaps.map((gap) => (
              <li key={gap.key} className="text-sm text-foreground wrap-anywhere">
                <span className="font-medium">{gap.title}</span>
                <span className="block text-xs text-(--nav-label-color)">{t('specReview.gapSection', { section: gap.specSection })}</span>
                <span className="block text-xs text-(--nav-label-color)">{t('specReview.gapEvidence', { evidence: gap.evidence })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
