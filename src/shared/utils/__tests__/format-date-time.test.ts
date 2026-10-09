import { describe, it, expect } from 'vitest';
import { formatDateTime, formatTime } from '../format-date-time';

describe('formatTime', () => {
  it('shows local time with seconds and AM/PM', () => {
    expect(formatTime(new Date(2026, 9, 10, 1, 35, 21))).toBe('1:35:21 AM');
    expect(formatTime(new Date(2026, 9, 10, 13, 5, 9))).toBe('1:05:09 PM');
  });

  it('accepts ISO strings and converts them to local time', () => {
    const local = new Date(2026, 9, 10, 1, 35, 21);
    expect(formatTime(local.toISOString())).toBe('1:35:21 AM');
  });

  it('returns an empty string for invalid dates', () => {
    expect(formatTime('not a date')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('shows the local date and time', () => {
    expect(formatDateTime(new Date(2026, 9, 10, 1, 35, 21))).toBe('10/10/2026, 1:35:21 AM');
  });

  it('returns an empty string for invalid dates', () => {
    expect(formatDateTime('')).toBe('');
  });
});
