import { describe, it, expect } from 'vitest';
import '../../../shared/i18n';
import { formatLongRelativeTime } from '../utils';

const NOW = new Date('2026-10-28T12:00:00Z').getTime();
const ago = (seconds: number) => formatLongRelativeTime(NOW - seconds * 1000, NOW);

describe('formatLongRelativeTime', () => {
  it('says how long ago in words', () => {
    expect(ago(0)).toBe('now');
    expect(ago(30)).toBe('30 seconds ago');
    expect(ago(5 * 60)).toBe('5 minutes ago');
    expect(ago(2 * 3600)).toBe('2 hours ago');
    expect(ago(86400)).toBe('yesterday');
    expect(ago(3 * 86400)).toBe('3 days ago');
    expect(ago(14 * 86400)).toBe('2 weeks ago');
    expect(ago(60 * 86400)).toBe('2 months ago');
    expect(ago(400 * 86400)).toBe('last year');
  });

  it('has no age for an unparsable date', () => {
    expect(formatLongRelativeTime('not a date', NOW)).not.toMatch(/NaN/);
  });
});
