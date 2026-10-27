/**
 * Holiday decorations on the ground behind Clawd: a couple of pumpkins on Halloween, and a couple
 * of wrapped presents over the winter holidays (December 20 to January 1).
 *
 * Pixel art in the widget's style: one letter per colour, "." for empty.
 */

import { isHalloween } from './skins';
import { isWinterHolidays } from './sky';
import type { Rect } from './sprite';

/** Units per art pixel, as the clouds */
export const DECOR_PX = 2;

export interface DecorPiece {
  /** Left edge as a fraction of the ground's width */
  at: number;
  w: number;
  h: number;
  layers: { color: string; rects: Rect[] }[];
}

/** Art into one list of merged rectangles per colour */
function piece(at: number, art: string[], colors: Record<string, string>): DecorPiece {
  const layers = Object.entries(colors).map(([key, color]) => {
    const rects: Rect[] = [];
    art.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (row[x] !== key) { x++; continue; }
        const x0 = x;
        while (x < row.length && row[x] === key) x++;
        rects.push({ x: x0 * DECOR_PX, y: y * DECOR_PX, w: (x - x0) * DECOR_PX, h: DECOR_PX });
      }
    });
    return { color, rects };
  });
  return { at, w: art[0].length * DECOR_PX, h: art.length * DECOR_PX, layers };
}

const PUMPKIN = { o: '#F97316', d: '#C2410C', g: '#4D7C0F' };

/** A jack-o'-lantern and a plain little pumpkin */
const PUMPKINS = [
  piece(0.08, [
    '.....g...',
    '....g....',
    '.ooodooo.',
    'ooyodoyoo',
    'oooodoooo',
    'ooyyyyyoo',
    '.ooodooo.',
  ], { ...PUMPKIN, y: '#FDE047' }),
  piece(0.82, [
    '...g...',
    '.oodoo.',
    'ooodooo',
    'ooodooo',
    '.oodoo.',
  ], PUMPKIN),
];

/** A red present with a gold ribbon and a green one with a red ribbon */
const PRESENTS = [
  piece(0.1, [
    '.yy..yy.',
    '..yyyy..',
    'rrryyrrr',
    'rrryyrrr',
    'yyyyyyyy',
    'rrryyrrr',
    'rrryyrrr',
  ], { r: '#DC2626', y: '#FBBF24' }),
  piece(0.8, [
    '.r..r.',
    '..rr..',
    'ggrrgg',
    'rrrrrr',
    'ggrrgg',
    'ggrrgg',
  ], { g: '#16A34A', r: '#DC2626' }),
];

/** What stands on the ground on this date, if anything */
export function holidayDecor(now: Date): DecorPiece[] {
  if (isHalloween(now)) return PUMPKINS;
  if (isWinterHolidays(now)) return PRESENTS;
  return [];
}
