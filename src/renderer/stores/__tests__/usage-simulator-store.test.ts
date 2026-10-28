import { describe, it, expect } from 'vitest';
import { simulatedMoment, TIME_MAX_MINUTES, useUsageSimulatorStore } from '../usage-simulator-store';

describe('simulatedMoment', () => {
  it('takes the time in the morning, or in the evening with pm', () => {
    const am = simulatedMoment('2026-10-28', 4 * 60 + 30, false);
    const pm = simulatedMoment('2026-10-28', 4 * 60 + 30, true);
    expect([am.getFullYear(), am.getMonth(), am.getDate(), am.getHours(), am.getMinutes()]).toEqual([2026, 9, 28, 4, 30]);
    expect([pm.getHours(), pm.getMinutes()]).toEqual([16, 30]);
  });

  it('uses today without a date, or with one it can\'t read', () => {
    const today = new Date();
    for (const date of [null, 'not a date']) {
      const moment = simulatedMoment(date, 0, false);
      expect([moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours()])
        .toEqual([today.getFullYear(), today.getMonth(), today.getDate(), 0]);
    }
  });
});

describe('setMinutes', () => {
  it('keeps the time on the slider\'s 30 minute steps, within the half day', () => {
    const { setMinutes } = useUsageSimulatorStore.getState();
    setMinutes(100);
    expect(useUsageSimulatorStore.getState().minutes).toBe(90);
    setMinutes(9999);
    expect(useUsageSimulatorStore.getState().minutes).toBe(TIME_MAX_MINUTES);
    setMinutes(-5);
    expect(useUsageSimulatorStore.getState().minutes).toBe(0);
  });
});
