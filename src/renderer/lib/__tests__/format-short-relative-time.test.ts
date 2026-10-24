/**
 * The age shown on a previous run's logs: short units, never a date, always from the
 * translation files.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import i18n from '../../../shared/i18n';
import { formatShortRelativeTime } from '../utils';

const NOW = new Date('2026-10-21T12:00:00.000Z');

function ago(seconds: number): string {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return formatShortRelativeTime(new Date(NOW.getTime() - seconds * 1000));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatShortRelativeTime', () => {
  it('counts seconds up to a minute', () => {
    expect(ago(0)).toBe('1 sec ago');
    expect(ago(42)).toBe('42 sec ago');
  });

  it('switches to minutes, hours and days', () => {
    expect(ago(60)).toBe('1 min ago');
    expect(ago(7 * 60)).toBe('7 min ago');
    expect(ago(3 * 3600)).toBe('3 h ago');
    expect(ago(5 * 86400)).toBe('5 d ago');
  });

  it('keeps counting in months and years instead of showing a date', () => {
    expect(ago(60 * 86400)).toBe('2 mo ago');
    expect(ago(400 * 86400)).toBe('1 y ago');
  });

  it('says the time is unknown rather than counting from an unparsable date', () => {
    expect(formatShortRelativeTime('not a date')).toBe('at an unknown time');
    expect(formatShortRelativeTime(Number.NaN)).toBe('at an unknown time');
    expect(formatShortRelativeTime(new Date('nonsense'))).toBe('at an unknown time');
  });

  it('takes its wording from the translation files', () => {
    expect(ago(3 * 3600)).toBe(i18n.t('common:relativeTime.hoursAgo', { value: 3 }));
  });
});
