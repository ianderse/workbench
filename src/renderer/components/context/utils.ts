import { formatDateTime } from '../../../shared/utils/format-date-time';

export function formatDate(timestamp: string): string {
  return formatDateTime(timestamp) || timestamp;
}
