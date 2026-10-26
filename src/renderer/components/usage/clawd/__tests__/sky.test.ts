/**
 * The sky's rules: the weather the 5-hour limit brings, and where the sun, the moon and the
 * stars are at a given time.
 */
import { describe, expect, it } from 'vitest';
import { moonArt, skyLook, sunTimes, usageWeather } from '../sky';

const OCTOBER = new Date(2026, 9, 26, 12);
const JANUARY = new Date(2027, 0, 15, 12);

describe('sky', () => {
  it('is fair under half the limit, then rains, harder and with thunder from 90%', () => {
    expect(usageWeather(null, OCTOBER).kind).toBe('fair');
    expect(usageWeather(49, OCTOBER).kind).toBe('fair');
    expect(usageWeather(50, OCTOBER)).toMatchObject({ kind: 'rain', storm: false });
    expect(usageWeather(75, OCTOBER).fall).toBeGreaterThan(usageWeather(50, OCTOBER).fall);
    expect(usageWeather(95, OCTOBER).storm).toBe(true);
  });

  it('snows instead of raining in winter', () => {
    expect(usageWeather(60, JANUARY)).toMatchObject({ kind: 'snow', storm: false });
  });

  it('rises before noon and sets after it', () => {
    const { sr, ss } = sunTimes(OCTOBER);
    expect(sr).toBeLessThan(ss);
    expect(sr).toBeGreaterThan(180);
    expect(ss).toBeLessThan(1380);
  });

  it('shows the sun at noon and the moon and stars at midnight', () => {
    const fair = usageWeather(10, OCTOBER);
    const noon = skyLook(OCTOBER, fair);
    expect(noon.sun).not.toBeNull();
    expect(noon.stars).toBe(0);
    const midnight = skyLook(new Date(2026, 9, 26, 0, 30), fair);
    expect(midnight.sun).toBeNull();
    expect(midnight.moon).not.toBeNull();
    expect(midnight.stars).toBeGreaterThan(0);
  });

  it('hides the sun behind rain clouds', () => {
    expect(skyLook(OCTOBER, usageWeather(80, OCTOBER)).sun).toBeNull();
  });

  it('draws a moon of 7x7 pixels', () => {
    const { lit, dark } = moonArt(OCTOBER);
    expect(lit).toHaveLength(7);
    expect(lit.join('').split('#').length + dark.join('').split('#').length).toBeGreaterThan(30);
  });
});
