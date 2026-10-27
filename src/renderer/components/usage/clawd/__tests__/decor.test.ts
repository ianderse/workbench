/**
 * Holiday decorations: pumpkins on Halloween, presents from December 20 to January 1.
 */
import { describe, expect, it } from 'vitest';
import { holidayDecor } from '../decor';
import { isWinterHolidays } from '../sky';

describe('holiday decorations', () => {
  it('puts out pumpkins only on Halloween', () => {
    expect(holidayDecor(new Date(2026, 9, 31, 20))).toHaveLength(2);
    expect(holidayDecor(new Date(2026, 9, 30, 20))).toHaveLength(0);
  });

  it('puts out presents from December 20 to January 1', () => {
    expect(isWinterHolidays(new Date(2026, 11, 19))).toBe(false);
    expect(isWinterHolidays(new Date(2026, 11, 20))).toBe(true);
    expect(isWinterHolidays(new Date(2026, 11, 31, 23))).toBe(true);
    expect(isWinterHolidays(new Date(2027, 0, 1))).toBe(true);
    expect(isWinterHolidays(new Date(2027, 0, 2))).toBe(false);
    expect(holidayDecor(new Date(2026, 11, 24))).toHaveLength(2);
  });

  it('leaves the ground bare on other days', () => {
    expect(holidayDecor(new Date(2026, 6, 4))).toHaveLength(0);
  });
});
