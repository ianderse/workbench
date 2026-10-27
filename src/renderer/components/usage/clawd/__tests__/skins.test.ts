/**
 * Clawd's skins: which ones he may wear when, when a new one is picked, and how the accessories
 * are drawn.
 */
import { describe, expect, it } from 'vitest';
import { getClawdGeo, makeFrame } from '../sprite';
import { SKINS, createSkinPicker, isHalloween, parseSkin, pickSkin, skinForUsage, skinPool } from '../skins';
import { isWinter } from '../sky';

const OCTOBER = new Date(2026, 9, 26, 12);
const JANUARY = new Date(2027, 0, 15, 12);

describe('skins', () => {
  it('has classic and every skin from the widget', () => {
    expect(SKINS).toHaveLength(28);
    expect(SKINS[0].id).toBe('classic');
    for (const s of SKINS.slice(1)) expect(s.layers.length).toBeGreaterThan(0);
  });

  it('reads the art rows from top, or right above his head without it', () => {
    const crown = SKINS.find((s) => s.id === 'crown')!;
    expect(Math.min(...crown.layers.flatMap((l) => l.px.map(([, y]) => y)))).toBe(-4);
    const nerd = SKINS.find((s) => s.id === 'nerd')!;
    expect(Math.min(...nerd.layers.flatMap((l) => l.px.map(([, y]) => y)))).toBe(1);
  });

  it('turns the widget #AARRGGBB colours into rgba', () => {
    const s = parseSkin('t', '---\ng: #6693C5FD\n---\ng\n');
    expect(s?.layers[0].color).toBe('rgba(147, 197, 253, 0.400)');
  });

  /** The skins he may wear at local time y-m-d h:00, with this much of the limit used */
  const ids = (y: number, m: number, d: number, h = 12, percent = 10) =>
    skinPool({ now: new Date(y, m - 1, d, h), percent }).map((s) => s.id);

  it('keeps the holiday skins for their days', () => {
    expect(ids(2026, 12, 19)).not.toContain('santa');
    expect(ids(2026, 12, 20)).toContain('santa');
    expect(ids(2026, 12, 31)).toContain('santa');
    expect(ids(2027, 1, 1)).not.toContain('santa');

    expect(ids(2027, 1, 1)).toContain('party');
    expect(ids(2026, 12, 31)).not.toContain('party');

    expect(isHalloween(new Date(2026, 9, 31))).toBe(true);
    for (const id of ['witch', 'zombie', 'skeleton', 'frankenstein', 'dracula']) {
      expect(ids(2026, 10, 31)).toContain(id);
      expect(ids(2026, 10, 30)).not.toContain(id);
    }
  });

  it('keeps the seasonal skins for their months', () => {
    expect(isWinter(JANUARY)).toBe(true);
    expect(isWinter(OCTOBER)).toBe(false);
    expect(ids(2027, 1, 15)).toContain('frost');
    expect(ids(2026, 11, 15)).not.toContain('frost');

    for (const id of ['parka', 'ushanka', 'pompom', 'cyanbeanie']) {
      expect(ids(2026, 11, 1)).toContain(id);
      expect(ids(2027, 3, 31)).toContain(id);
      expect(ids(2026, 10, 31)).not.toContain(id);
      expect(ids(2027, 4, 1)).not.toContain(id);
    }
    for (const id of ['flowershorts', 'squarepants', 'redcrab', 'frycook']) {
      expect(ids(2026, 7, 10)).toContain(id);
      expect(ids(2026, 9, 1)).not.toContain(id);
    }
    expect(ids(2026, 7, 10, 12)).toContain('shades');
    expect(ids(2026, 7, 10, 2)).not.toContain('shades');
    expect(ids(2026, 1, 10, 12)).not.toContain('shades');
  });

  it('fits the astronaut and the tired look to the time and the limit', () => {
    expect(ids(2026, 10, 26, 23)).toContain('astronaut');
    expect(ids(2026, 10, 26, 12)).not.toContain('astronaut');
    expect(ids(2026, 10, 26, 3)).toContain('tired');
    expect(ids(2026, 10, 26, 12)).not.toContain('tired');
    expect(ids(2026, 10, 26, 12, 85)).toContain('tired');
  });

  it('wears any day the skins with no moment of their own', () => {
    for (const [m, d] of [[1, 15], [4, 10], [7, 10], [10, 26]]) {
      for (const id of ['classic', 'tophat', 'ears', 'bow', 'nerd', 'headtie', 'rockerboy', 'netrunner']) {
        expect(ids(2026, m, d)).toContain(id);
      }
      expect(ids(2026, m, d)).not.toContain('crown');
    }
  });

  it('never picks the skin he already wears', () => {
    const current = SKINS[3];
    const moment = { now: OCTOBER, percent: 10 };
    for (let i = 0; i < 20; i++) expect(pickSkin(current, moment, () => i / 20).id).not.toBe(current.id);
  });

  it('changes skin only when the usage numbers change, and crowns him when the window resets', () => {
    const a = skinForUsage({ session: 10, weekly: 20 }, OCTOBER);
    expect(skinForUsage({ session: 10, weekly: 20 }, OCTOBER)).toBe(a);
    const b = skinForUsage({ session: 11, weekly: 20 }, OCTOBER);
    expect(b).not.toBe(a);
    expect(b.id).not.toBe('crown');
    expect(skinForUsage({ session: 0, weekly: 21 }, OCTOBER).id).toBe('crown');
  });

  it('crowns him only when the same account\'s window resets, even one missed while closed', () => {
    const pick = createSkinPicker();
    const at = (h: number) => new Date(Date.UTC(2026, 9, 27, h)).toISOString();
    const now = new Date(Date.UTC(2026, 9, 27, 12));
    pick({ session: 80, weekly: 20, profile: 'a', reset: at(14) }, now);
    // Another account with less used is not a reset
    expect(pick({ session: 10, weekly: 20, profile: 'b', reset: at(13) }, now).id).not.toBe('crown');
    // The window reset and filled up past where it was while nobody looked
    pick({ session: 40, weekly: 20, profile: 'a', reset: at(14) }, now);
    expect(pick({ session: 55, weekly: 21, profile: 'a', reset: at(20) }, now).id).toBe('crown');
    // A slightly different reset time for the same window is not a reset
    expect(pick({ session: 50, weekly: 21, profile: 'a', reset: new Date(Date.UTC(2026, 9, 27, 20, 0, 40)).toISOString() }, now).id).not.toBe('crown');
  });

  it('draws the accessories standing, and drops them lying on his back', () => {
    const tophat = SKINS.find((s) => s.id === 'tophat')!;
    expect(getClawdGeo(makeFrame(), tophat).acc.some((l) => l.rects.length > 0)).toBe(true);
    expect(getClawdGeo(makeFrame({ flip: true, eyes: 'x' }), tophat).acc.every((l) => l.rects.length === 0)).toBe(true);
  });
});
