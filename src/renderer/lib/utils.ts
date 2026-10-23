import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

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

const SHORT_UNITS: Array<{ limit: number; per: number; unit: string }> = [
  { limit: 60, per: 1, unit: 'sec' },
  { limit: 3600, per: 60, unit: 'min' },
  { limit: 86400, per: 3600, unit: 'h' },
  { limit: 2592000, per: 86400, unit: 'd' },
  { limit: 31536000, per: 2592000, unit: 'mo' },
];

/**
 * How long ago something happened, in short units: "42 sec ago", "7 min ago", "3 h ago",
 * "5 d ago", "2 mo ago", "1 y ago". Unlike {@link formatRelativeTime} it never falls back to a
 * date, so an old entry still reads as an age.
 */
export function formatShortRelativeTime(date: Date | string | number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  for (const { limit, per, unit } of SHORT_UNITS) {
    if (seconds < limit) return `${Math.floor(seconds / per)} ${unit} ago`;
  }
  return `${Math.floor(seconds / 31536000)} y ago`;
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
