/**
 * The sky's rules: the weather the 5-hour limit brings, and where the sun, the moon and the
 * stars are at a given time.
 */
import { describe, expect, it, vi } from 'vitest';
import { isSouthern, moonLitPath, skyBodyPos, skyLook, sunTimes, usageWeather } from '../sky';

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

  it('always snows over the winter holidays, heavily from 50%', () => {
    const christmas = new Date(2026, 11, 24, 12);
    expect(usageWeather(null, christmas).kind).toBe('snow');
    expect(usageWeather(10, christmas)).toMatchObject({ kind: 'snow', storm: false });
    expect(usageWeather(60, christmas).fall).toBeGreaterThan(usageWeather(10, christmas).fall);
    expect(usageWeather(60, christmas).fall).toBeGreaterThan(usageWeather(60, JANUARY).fall);
    // A light snowfall still lets the sun through
    expect(skyLook(christmas, usageWeather(10, christmas)).sun).not.toBeNull();
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

  it('draws the lit part of the moon as a closed path on its disc', () => {
    const d = moonLitPath(OCTOBER, 20, 10, 4.5);
    expect(d).toMatch(/^M 20 5\.5 A 4\.5 4\.5 .* Z$/);
  });

  it('keeps the sun and the moon in the cloud band, away from the faded edges', () => {
    for (const p of [-0.05, 0, 0.25, 0.5, 0.75, 1, 1.05]) {
      const { cx, cy } = skyBodyPos(p, 300);
      expect(cy).toBeGreaterThanOrEqual(7);
      expect(cy).toBeLessThanOrEqual(15);
      expect(cx).toBeGreaterThanOrEqual(300 * 0.16 - 1e-9);
      expect(cx).toBeLessThanOrEqual(300 * 0.84 + 1e-9);
    }
    expect(skyBodyPos(0.5, 300).cy).toBeLessThan(skyBodyPos(0.1, 300).cy);
  });

  it('places every Argentine time zone in the south, under either of its names', () => {
    const inZone = (timeZone: string) => {
      const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
        () => ({ resolvedOptions: () => ({ timeZone }) }) as unknown as Intl.DateTimeFormat,
      );
      try {
        return isSouthern(OCTOBER);
      } finally {
        spy.mockRestore();
      }
    };
    for (const zone of ['America/Cordoba', 'America/Mendoza', 'America/Buenos_Aires', 'America/Argentina/Salta']) {
      expect(inZone(zone)).toBe(true);
    }
  });
});
