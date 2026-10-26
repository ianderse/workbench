/**
 * Clawd - the crab from the Claude Code welcome screen
 *
 * Drawn from the same block glyphs as the terminal: 9 cells by 3 rows, each cell split into
 * 2x4 pixels so the quadrant glyphs and the "lower quarter" eyelid map losslessly, and a pixel
 * comes out almost square. Ported from the clawd-usage widget
 * (https://github.com/Enhed/clawd-usage-winwidget, lib/mascot.ps1).
 *
 * Everything here is pure geometry: a frame description goes in, a list of rectangles in
 * mascot-local units comes out, ready to drop into an <svg>.
 */

/** Clawd is 9 glyph cells wide and 3 tall */
const CLAWD_COLS = 9;
const CLAWD_ROWS = 3;
/** One pixel: two per glyph cell across, four down */
const MASCOT_PX = 2.0;
export const MASCOT_PY = 2.2;
/** Pixel grid size */
const GRID_W = 2 * CLAWD_COLS;
const GRID_H = 4 * CLAWD_ROWS;
/** Rendered size of the mascot box */
export const MASCOT_W = GRID_W * MASCOT_PX;
export const MASCOT_H = GRID_H * MASCOT_PY;
/** The lower half of the legs row is empty - the box sits that much below the ground */
export const MASCOT_SINK = 2 * MASCOT_PY;

/** Body colour, as on the welcome screen */
export const CLAWD_BODY = '#D77757';
/** Eyes and the black of the face */
export const CLAWD_EYE = '#141416';
/** Dust, poofs and the hop shadow */
export const CLAWD_FX = '#6B7280';
/** Sand of the burrow */
export const CLAWD_SAND = '#B8955E';

import type { ClawdSkin } from './skins';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The layers a frame paints, in draw order */
export interface ClawdGeo {
  sand: Rect[];
  body: Rect[];
  eyes: Rect[];
  /** The skin's accessories, one colour each */
  acc: { color: string; rects: Rect[] }[];
  fx: Rect[];
}

/** Everything that decides what a single frame looks like */
export interface ClawdFrame {
  eyes: string;
  arms: string;
  feet: string;
  /** -1, 0 or 1: which way the pupils point */
  look: number;
  /** Lying on his back, legs up */
  flip: boolean;
  /** Rows lowered: 1 crouched (legs hidden), 3 fully hidden, negative above the frame */
  off: number;
  /** Shift in glyph cells */
  x: number;
  /** A turn-in-place pose, which replaces the body entirely */
  facing: string;
  /** Dust puffs at the sides while crouching: 'dot' or 'wave' */
  poof: string;
  /** Shadow under the hopping coin: 'wide' or 'narrow' */
  shadow: string;
  /** Pixel rows sunk into the sand (4 = only the top of the head and the eyes stick out) */
  dig: number;
  /** Phase of the sand grains flying from the legs, 0 for none */
  spray: number;
}

/** Quadrant bits of a glyph: 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right */
const QUAD: Record<string, number> = {};
for (const p of [' 0', '█15', '▀3', '▄12', '▌5', '▐10', '▘1', '▝2', '▖4', '▗8',
                 '▛7', '▜11', '▙13', '▟14']) {
  QUAD[p[0]] = parseInt(p.slice(1), 10);
}

/** Arms: what sits left and right of the eyes (row 0) and of the chest (row 1) */
const ARMS: Record<string, { r1L: string; r1R: string; r2L: string; r2R: string }> = {
  down:  { r1L: ' ▐', r1R: '',  r2L: '▝▜', r2R: '█▀' },
  up:    { r1L: '▗▟', r1R: '▄', r2L: ' ▜', r2R: '█▘' },
  right: { r1L: ' ▐', r1R: '▄', r2L: '▝▜', r2R: '█▘' },   // one-up in Claude Code
  left:  { r1L: '▗▟', r1R: '',  r2L: ' ▜', r2R: '█▀' },
};

const FEET: Record<string, string> = {
  both:  ' ▝▝   ▝▝ ',
  left:  ' ▝▝      ',
  right: '      ▝▝ ',
};

/** Turns in place: glyph rows, and the columns from..to where the black face shows */
const FACING: Record<string, [string, number, number][]> = {
  'right-12': [[' ▐█▜██▛█ ', 2, 8], ['▝▜██████▀', 2, 7], [' ▝▝   ▝▝ ', 0, 0]],
  'right-30': [['  █▛██▛▌ ', 2, 7], [' ▝█████▛ ', 2, 7], ['  ▘▘  ▘▘ ', 0, 0]],
  'right-55': [['  ▐█▛█▜  ', 3, 7], ['  ▐████  ', 3, 7], ['  ▝▝ ▝▝  ', 0, 0]],
  'right-75': [['   ██▛▌  ', 3, 6], ['   ███▌  ', 3, 6], ['   ▘  ▘  ', 0, 0]],
  'edge':     [['   ▐██   ', 4, 6], ['   ▐██   ', 4, 6], ['   ▝ ▝   ', 0, 0]],
  'back-105': [['   ███▌  ', 3, 6], ['   ███▌  ', 3, 6], ['   ▘  ▘  ', 0, 0]],
  'back-125': [['  ▐████  ', 3, 7], ['  ▐████  ', 3, 7], ['  ▝▝ ▝▝  ', 0, 0]],
  'back-150': [['  █████▌ ', 2, 7], [' ▝█████▛ ', 2, 7], ['  ▘▘  ▘▘ ', 0, 0]],
  'back':     [[' ▐██████ ', 2, 8], ['▝▜██████▀', 2, 7], [' ▝▝   ▝▝ ', 0, 0]],
  'left-75':  [['   ▛██▌  ', 3, 6], ['   ███▌  ', 3, 6], ['   ▘  ▘  ', 0, 0]],
  'left-55':  [['  ▐▜▛██  ', 3, 7], ['  ▐████  ', 3, 7], ['  ▝▝ ▝▝  ', 0, 0]],
  'left-30':  [['  ▛██▛█▌ ', 2, 7], [' ▝█████▛ ', 2, 7], ['  ▘▘  ▘▘ ', 0, 0]],
  'left-12':  [[' ▐▛███▜█ ', 2, 8], ['▝▜██████▀', 2, 7], [' ▝▝   ▝▝ ', 0, 0]],
};

/**
 * Eyes: black pixels "dx,dy" from the top-left corner of the eye cell (columns 2 and 6 of the
 * first row). With ";" - the left and the right eye separately. open/left/right/closed/wink are
 * exactly as in Claude Code, the rest are our own.
 */
const EYE_SHAPES: Record<string, string> = {
  open:   '1,2 1,3',                             // normal
  left:   '0,0 0,1',                             // looking left
  right:  '2,0 2,1',                             // looking right
  closed: '0,3 1,3',                             // eyelid line, asleep
  blink:  '0,3 1,3',                             // blink
  wink:   '1,2 1,3;0,3 1,3',                     // wink
  happy:  '0,3 1,2 2,3',                         // happy ^ ^
  focus:  '1,3',                                 // focused squint
  wide:   '0,1 1,1 0,2 1,2 0,3 1,3',             // wide open
  x:      '0,1 2,1 1,2 0,3 2,3',                 // crosses
  yawn:   '0,3 1,3',                             // yawning (mouth drawn separately)
  gasp:   '0,1 2,1 1,2 0,3 2,3',                 // crosses with an open mouth - soul leaving
};

/** Pixel rows the head sinks when fully burrowed */
export const BURROW_DIG = 4;

/** A frame's geometry is reused a lot, so each one is built once and kept */
const geoCache = new Map<string, ClawdGeo>();

export function makeFrame(over: Partial<ClawdFrame> = {}): ClawdFrame {
  return {
    eyes: 'open', arms: 'down', feet: 'both', look: 0, flip: false,
    off: 0, x: 0, facing: '', poof: '', shadow: '', dig: 0, spray: 0,
    ...over,
  };
}

/**
 * Paint glyphs into the pixel grid.
 *
 * mode 'eyes' fills the cell's background black and the glyph in body colour (that is how the
 * face is cut out of the body); 'lid' is the other way round; '' leaves the background empty.
 */
function paint(g: Uint8Array, glyphs: string, col: number, row: number, mode: string): void {
  const fg = mode === 'lid' ? 2 : 1;
  const bg = mode === 'eyes' ? 2 : mode === 'lid' ? 1 : 0;
  for (let i = 0; i < glyphs.length; i++) {
    const c = glyphs[i];
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const bit = (sy < 2 ? 1 : 4) * (sx ? 2 : 1);
        const on = c === '▂' ? sy === 3 : ((QUAD[c] ?? 0) & bit) !== 0;
        const v = on ? fg : bg;
        if (v) g[(4 * row + sy) * GRID_W + 2 * (col + i) + sx] = v;
      }
    }
  }
}

/** Build the 18x12 pixel grid: 0 empty, 1 body, 2 black */
function buildGrid(f: ClawdFrame): Uint8Array {
  const g = new Uint8Array(GRID_W * GRID_H);

  if (f.facing) {
    FACING[f.facing].forEach(([s, from, to], r) => {
      paint(g, s.slice(0, from), 0, r, '');
      paint(g, s.slice(from, to), from, r, 'eyes');
      paint(g, s.slice(to), to, r, '');
    });
    return g;
  }

  const a = ARMS[f.arms] ?? ARMS.down;
  paint(g, a.r1L, 0, 0, '');
  paint(g, '██████', 2, 0, 'eyes');
  paint(g, a.r1R, 8, 0, '');
  paint(g, a.r2L, 0, 1, '');
  paint(g, '█████', 2, 1, 'eyes');
  paint(g, a.r2R, 7, 1, '');
  paint(g, FEET[f.feet] ?? FEET.both, 0, 2, '');

  // Looking sideways with normal eyes uses the ready-made Claude Code poses; for the other
  // expressions the pupils just shift.
  let eyes = f.eyes;
  let shift = 0;
  if (eyes === 'open' && f.look < 0) eyes = 'left';
  else if (eyes === 'open' && f.look > 0) eyes = 'right';
  else if (!['open', 'left', 'right', 'wink'].includes(eyes)) shift = f.look;

  const sh = (EYE_SHAPES[eyes] ?? EYE_SHAPES.open).split(';');
  const ex = [4, 12];
  for (let k = 0; k < 2; k++) {
    for (const pt of sh[Math.min(k, sh.length - 1)].split(' ')) {
      const [dx, dy] = pt.split(',').map(Number);
      const px = ex[k] + dx + shift;
      if (px >= 0 && px < GRID_W) g[dy * GRID_W + px] = 2;
    }
  }
  // Yawn: squeezed-shut eyes plus an open mouth.
  if (eyes === 'yawn' || eyes === 'gasp') {
    for (let x = 8; x <= 10; x++) { g[4 * GRID_W + x] = 2; g[5 * GRID_W + x] = 2; }
  }
  return g;
}

/** Geometry for one frame in a skin. Cached, so callers may call it every tick. */
export function getClawdGeo(f: ClawdFrame, skin?: ClawdSkin): ClawdGeo {
  const key = `${skin?.id ?? 'classic'}|${f.eyes}|${f.arms}|${f.feet}|${f.look}|${f.flip}|${f.off}|${f.x}|${f.facing}|${f.poof}|${f.shadow}|${f.dig}|${f.spray}`;
  const hit = geoCache.get(key);
  if (hit) return hit;

  const g = buildGrid(f);
  const body: Rect[] = [];
  const eyes: Rect[] = [];
  const fx: Rect[] = [];
  const sand: Rect[] = [];

  // Lowered by off rows and shifted by x cells; anything outside the frame is clipped, and what
  // sank into the burrow is clipped at the ground - the edge of the empty lower half-row.
  const oy = 4 * f.off + f.dig;
  const ox = 2 * f.x;
  const lim = f.dig > 0 ? GRID_H - 2 : GRID_H;

  for (let y = 0; y < GRID_H; y++) {
    // Flipped - lying on his back; the empty lower half-row does not take part.
    let sy = y;
    if (f.flip) {
      if (y >= GRID_H - 2) continue;
      sy = GRID_H - 3 - y;
    }
    const yy = sy + oy;
    if (yy < 0 || yy >= lim) continue;

    let x = 0;
    while (x < GRID_W) {
      const c = g[y * GRID_W + x];
      if (!c) { x++; continue; }
      // Merge adjacent pixels of the same colour into one rectangle.
      const x0 = x;
      while (x < GRID_W && g[y * GRID_W + x] === c) x++;
      const l = Math.max(0, x0 + ox);
      const r = Math.min(GRID_W, x + ox);
      if (r <= l) continue;
      const rect = { x: l * MASCOT_PX, y: yy * MASCOT_PY, w: (r - l) * MASCOT_PX, h: MASCOT_PY };
      (c === 2 ? eyes : body).push(rect);
    }
  }

  // Skin accessories, in Clawd's pixels (rows above his head are negative). Above the head they
  // show while the head is in the frame, on the body like the body; turning in place only what
  // is above the head stays, and lying on his back he loses them all.
  const acc: ClawdGeo['acc'] = [];
  for (const layer of skin?.layers ?? []) {
    const rects: Rect[] = [];
    if (!f.flip) {
      for (const [lx, ly] of layer.px) {
        const x = lx + ox;
        const yy = ly + oy;
        if (ly >= 0 && f.facing) continue;
        if (x < 0 || x >= GRID_W || yy >= lim) continue;
        if (ly < 0 ? oy < 0 : yy < 0) continue;
        // Pixels come row by row, left to right: grow the last run when this one touches it
        const last = rects[rects.length - 1];
        if (last && last.y === yy * MASCOT_PY && last.x + last.w === x * MASCOT_PX) last.w += MASCOT_PX;
        else rects.push({ x: x * MASCOT_PX, y: yy * MASCOT_PY, w: MASCOT_PX, h: MASCOT_PY });
      }
    }
    acc.push({ color: layer.color, rects });
  }

  // Dust "·" and "~" at the edges of the bottom row while crouched.
  if (f.poof && f.off > 0) {
    for (const cx of [0, GRID_W - 2]) {
      const pts = f.poof === 'dot'
        ? [[0.6, 9.4, 0.8, 0.9]]
        : [[0.0, 9.6, 0.7, 0.6], [0.7, 9.1, 0.6, 0.6], [1.3, 9.6, 0.7, 0.6]];
      for (const [px, py, pw, ph] of pts) {
        fx.push({ x: (cx + px) * MASCOT_PX, y: py * MASCOT_PY, w: pw * MASCOT_PX, h: ph * MASCOT_PY });
      }
    }
  }

  // Shadow "▁" under the hopping coin.
  if (f.shadow) {
    const [sc, sw] = f.shadow === 'wide' ? [6, 6] : [8, 2];
    fx.push({ x: sc * MASCOT_PX, y: (GRID_H - 0.5) * MASCOT_PY, w: sw * MASCOT_PX, h: 0.5 * MASCOT_PY });
  }

  // Sand mound over the burrow: a strip along the ground and piles at the sides where he dug.
  const px = (x: number, y: number, w: number, h: number) =>
    sand.push({ x: x * MASCOT_PX, y: y * MASCOT_PY, w: w * MASCOT_PX, h: h * MASCOT_PY });
  if (f.dig >= 1) px(-2, GRID_H - 3, GRID_W + 4, 1);
  if (f.dig >= 2) px(-1, GRID_H - 4, GRID_W + 2, 1);
  if (f.dig >= 3) { px(-1, GRID_H - 5, 2, 1); px(GRID_W - 1, GRID_H - 5, 2, 1); }

  // Sand grains fly in an arc from under the legs to both sides.
  if (f.spray > 0) {
    for (const k of [0, 1]) {
      const d = f.spray + 2 * k;
      const sx = 1.5 + 0.9 * d;
      const sy = (GRID_H - 4) - 0.9 * d * (5 - d) / 2;
      px(-sx, sy, 0.8, 0.8);
      px(GRID_W - 0.8 + sx, sy, 0.8, 0.8);
    }
  }

  const geo: ClawdGeo = { sand, body, eyes, acc, fx };
  geoCache.set(key, geo);
  return geo;
}

/** Soul: a translucent mini-Clawd with a tail, on a thread running back to the mouth */
const SOUL_PX = 1.4;
const SOUL_ART = [
  '..########..',
  '..#.####.#..',
  '############',
  '..########..',
  '...######...',
  '....####....',
  '.....##.....',
];

/** The soul at height h above the mouth, swaying and pulling the thread with it */
export function getSoulGeo(h: number, t: number): Rect[] {
  const out: Rect[] = [];
  const p = SOUL_PX;
  const sway = 2.5 * Math.sin(t / 4.0);
  const add = (x: number, y: number, w: number) => out.push({ x, y, w, h: p });

  // Thread: from the mouth up to the soul's tail, wiggling and following the sway.
  const n = Math.floor(h / p);
  for (let i = 0; i < n; i++) {
    const k = i / Math.max(1, n);
    const dx = sway * k + 1.2 * Math.sin(t / 2.0 + i * 0.7) * Math.sin(k * Math.PI);
    add(Math.round(dx / p) * p - p / 2, -(i + 1) * p, p);
  }

  const top = -h - SOUL_ART.length * p;
  const x0 = Math.round(sway / p) * p - 6 * p;
  for (let y = 0; y < SOUL_ART.length; y++) {
    const row = SOUL_ART[y];
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') { x++; continue; }
      const a = x;
      while (x < row.length && row[x] === '#') x++;
      add(x0 + a * p, top + y * p, (x - a) * p);
    }
  }
  return out;
}
