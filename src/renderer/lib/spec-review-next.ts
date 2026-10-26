import type { TFunction } from 'i18next';
import { taskNumber } from '../../shared/utils/queue-grooming';

/** The sentence for a `specReviewNextKey()` value ('' when there is nothing to say) */
export function specReviewNextText(key: string, t: TFunction): string {
  if (!key) return '';
  if (key === 'complete') return t('specReview.complete');
  if (key === 'unverified') return t('specReview.unverified');
  if (key === 'gaps_open') return t('specReview.lastReview');
  const ids = key.slice('tickets:'.length).split(',').filter(Boolean);
  return ids.length > 0 ? t('specReview.nextReview', { tickets: ids.map((id) => `#${taskNumber(id)}`).join(', ') }) : '';
}
