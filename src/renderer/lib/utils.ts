import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
// The i18next singleton that src/shared/i18n configures, imported straight from the package so
// that pulling this module in never drags react-i18next along with it
import i18n from 'i18next';

/**
 * Utility function to merge Tailwind CSS classes
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a date as a relative time string
 * @param date Date to format
 * @returns Relative time string (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(date).toLocaleDateString();
}

const LONG_UNITS: Array<{ limit: number; per: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { limit: 60, per: 1, unit: 'second' },
  { limit: 3600, per: 60, unit: 'minute' },
  { limit: 86400, per: 3600, unit: 'hour' },
  { limit: 604800, per: 86400, unit: 'day' },
  { limit: 2592000, per: 604800, unit: 'week' },
  { limit: 31536000, per: 2592000, unit: 'month' },
];

/**
 * How long ago something happened, in words of the app's language: "2 hours ago", "yesterday",
 * "3 weeks ago" (Intl.RelativeTimeFormat)
 */
export function formatLongRelativeTime(date: Date | string | number, now: number = Date.now()): string {
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return i18n.t('common:relativeTime.unknown');
  const format = new Intl.RelativeTimeFormat(i18n.language || 'en', { numeric: 'auto' });
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  for (const { limit, per, unit } of LONG_UNITS) {
    if (seconds < limit) return format.format(-Math.floor(seconds / per), unit);
  }
  return format.format(-Math.floor(seconds / 31536000), 'year');
}

const SHORT_UNITS: Array<{ limit: number; per: number; key: string }> = [
  { limit: 60, per: 1, key: 'common:relativeTime.secondsAgo' },
  { limit: 3600, per: 60, key: 'common:relativeTime.minutesAgo' },
  { limit: 86400, per: 3600, key: 'common:relativeTime.hoursAgo' },
  { limit: 2592000, per: 86400, key: 'common:relativeTime.daysAgo' },
  { limit: 31536000, per: 2592000, key: 'common:relativeTime.monthsAgo' },
];

/**
 * How long ago something happened, in short units: "42 sec ago", "7 min ago", "3 h ago",
 * "5 d ago", "2 mo ago", "1 y ago". Unlike {@link formatRelativeTime} it never falls back to a
 * date, so an old entry still reads as an age.
 *
 * The wording comes from the translation files. This is a plain function rather than a hook, so
 * it reads them through the configured i18next instance instead of a `t` from a component.
 */
export function formatShortRelativeTime(date: Date | string | number): string {
  const time = new Date(date).getTime();
  // An unparsable date has no age to show, and arithmetic on it would read as "NaN y ago"
  if (Number.isNaN(time)) return i18n.t('common:relativeTime.unknown');
  const seconds = Math.max(1, Math.floor((Date.now() - time) / 1000));
  for (const { limit, per, key } of SHORT_UNITS) {
    if (seconds < limit) return i18n.t(key, { value: Math.floor(seconds / per) });
  }
  return i18n.t('common:relativeTime.yearsAgo', { value: Math.floor(seconds / 31536000) });
}

/**
 * Sanitize and extract plain text from markdown content.
 * Strips markdown formatting and collapses whitespace for clean display in UI.
 * @param text The text that might contain markdown
 * @param maxLength Maximum length before truncation (default: 200)
 * @returns Plain text suitable for display
 */
export function sanitizeMarkdownForDisplay(text: string, maxLength: number = 200): string {
  if (!text) return '';

  let sanitized = text
    // Remove markdown headers (# ## ### etc)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove blockquotes
    .replace(/^>\s*/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove checkbox markers
    .replace(/\[[ x]\]\s*/gi, '')
    // Collapse multiple newlines to single space
    .replace(/\n+/g, ' ')
    // Collapse multiple spaces to single space
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate if needed (0 means no truncation)
  if (maxLength > 0 && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength).trim() + '...';
  }

  return sanitized;
}
