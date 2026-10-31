/**
 * The pixel heart, shared by the header's three hearts and the one Clawd lets go when petted.
 *
 * Three hearts are the 5-hour limit left. They fill by pixel column rather than by half, so a
 * heart has seven steps instead of two and the three together read to about 5% - but a heart
 * empties completely only at 100% used, exactly when Clawd lies down.
 */

import type { Rect } from './sprite';

const HEART_PX = 1.4;

const HEART_ROWS = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];

/** How many pixel columns a whole heart is */
export const HEART_COLS = HEART_ROWS[0].length;

/** Heart pixels in the first `cols` columns, merged into runs */
function heartGeo(cols: number): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < HEART_ROWS.length; y++) {
    let x = 0;
    while (x < cols) {
      if (HEART_ROWS[y][x] !== '#') { x++; continue; }
      const x0 = x;
      while (x < cols && HEART_ROWS[y][x] === '#') x++;
      out.push({ x: x0 * HEART_PX, y: y * HEART_PX, w: (x - x0) * HEART_PX, h: HEART_PX });
    }
  }
  return out;
}

/** Every fill step, from empty at index 0 to the whole heart at index HEART_COLS */
export const HEART_BY_COLS: Rect[][] =
  Array.from({ length: HEART_COLS + 1 }, (_, cols) => heartGeo(cols));

export const HEART_FULL = HEART_BY_COLS[HEART_COLS];
export const HEART_H = HEART_ROWS.length * HEART_PX;

/**
 * Columns to light for a heart filled by `fill` (0..1).
 *
 * Rounded up, so any sliver left still shows a column and a heart goes dark only once there is
 * genuinely nothing left in it.
 */
export function heartColumns(fill: number): number {
  return Math.min(HEART_COLS, Math.max(0, Math.ceil(fill * HEART_COLS)));
}
