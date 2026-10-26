/**
 * Clawd's skins: his colours plus pixel accessories on top - a hat, a crown, glasses.
 *
 * Copied from the clawd-usage widget (https://github.com/Enhed/clawd-usage-winwidget, skins/
 * and lib/skins.ps1, MIT). Each skin is the widget's own text file:
 *   name, body and eyes colours, `top` (the first art row, counted from Clawd's top row;
 *   without it the art sits right on his head) and one colour per art letter, then the art,
 *   18 pixels wide like Clawd, "." for empty.
 * Colours are CSS hex or the widget's #AARRGGBB.
 */

import { isWinter, seasonMonth, sunTimes } from './sky';
import { CLAWD_BODY, CLAWD_EYE } from './sprite';

export interface SkinLayer {
  color: string;
  /** Pixels in Clawd's grid; rows above his head are negative */
  px: [number, number][];
}

export interface ClawdSkin {
  id: string;
  body: string;
  eyes: string;
  layers: SkinLayer[];
}

export const CLASSIC_SKIN: ClawdSkin = { id: 'classic', body: CLAWD_BODY, eyes: CLAWD_EYE, layers: [] };


/** Clawd's pixel grid is 18 wide */
const GRID_W = 18;

/** The widget's #AARRGGBB becomes rgba(); plain #RRGGBB stays as it is */
function cssColor(hex: string): string {
  if (hex.length !== 9) return hex;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgba(${n(3)}, ${n(5)}, ${n(7)}, ${(n(1) / 255).toFixed(3)})`;
}

/** A skin file, as lib/skins.ps1 reads it */
export function parseSkin(id: string, raw: string): ClawdSkin | null {
  const m = /^\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const skin: ClawdSkin = { id, body: CLAWD_BODY, eyes: CLAWD_EYE, layers: [] };
  const colors: Record<string, string> = {};
  let top: number | null = null;
  for (const line of m[1].split('\n')) {
    const kv = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    const ok = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v);
    if (k === 'body') { if (ok) skin.body = cssColor(v); }
    else if (k === 'eyes') { if (ok) skin.eyes = cssColor(v); }
    else if (k === 'top') { if (/^-?\d+$/.test(v)) top = parseInt(v, 10); }
    else if (k.length === 1 && ok) colors[k] = cssColor(v);
  }
  const rows = m[2].split('\n').map((r) => r.trimEnd());
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  const first = top ?? -rows.length;
  const byColor = new Map<string, [number, number][]>();
  rows.forEach((row, y) => {
    for (let x = 0; x < Math.min(row.length, GRID_W); x++) {
      const c = row[x];
      if (!colors[c]) continue;
      if (!byColor.has(c)) byColor.set(c, []);
      byColor.get(c)!.push([x, first + y]);
    }
  });
  for (const [c, px] of byColor) skin.layers.push({ color: colors[c], px });
  return skin;
}

/** What decides which skins fit right now */
export interface SkinMoment {
  now: Date;
  /** 5-hour usage, or null when unknown */
  percent: number | null;
}

/**
 * The season's month (1-12, as in the north) falls in from..to, wrapping round the new year;
 * south of the equator the months are half a year apart
 */
function inMonths(now: Date, from: number, to: number): boolean {
  const m = seasonMonth(now);
  return from <= to ? m >= from && m <= to : m >= from || m <= to;
}

/** A calendar date, month 1-12 */
const onDate = (now: Date, month: number, day: number) =>
  now.getMonth() + 1 === month && now.getDate() === day;

/** Between sunrise and sunset, as the sky works them out */
function isDaytime(now: Date): boolean {
  const { sr, ss } = sunTimes(now);
  const t = now.getHours() * 60 + now.getMinutes();
  return t >= sr && t < ss;
}

/** Halloween itself, October 31 */
export function isHalloween(now: Date): boolean {
  return onDate(now, 10, 31);
}

const halloween = ({ now }: SkinMoment) => isHalloween(now);
/** November to March: hats and coats for the cold */
const coldMonths = ({ now }: SkinMoment) => inMonths(now, 11, 3);
/** June to August: the beach crowd */
const summer = ({ now }: SkinMoment) => inMonths(now, 6, 8);

/**
 * When each skin may be worn; a skin not listed here can be worn any day. A skin keeps on until
 * the usage numbers next change, even when its moment has passed by then.
 */
const WHEN: Record<string, (m: SkinMoment) => boolean> = {
  // Holidays
  santa: ({ now }) => now.getMonth() === 11 && now.getDate() >= 20,
  party: ({ now }) => onDate(now, 1, 1),
  witch: halloween,
  zombie: halloween,
  skeleton: halloween,
  frankenstein: halloween,
  dracula: halloween,
  // Seasons
  frost: ({ now }) => isWinter(now),
  parka: coldMonths,
  ushanka: coldMonths,
  pompom: coldMonths,
  cyanbeanie: coldMonths,
  flowershorts: summer,
  squarepants: summer,
  redcrab: summer,
  frycook: summer,
  shades: ({ now }) => inMonths(now, 5, 9) && isDaytime(now),
  // Time of day and the limit
  astronaut: ({ now }) => !isDaytime(now),
  tired: ({ now, percent }) => now.getHours() < 5 || (percent ?? 0) >= 80,
  // The crown is only ever put on when the 5-hour window resets (see skinForUsage)
  crown: () => false,
};

/** The skins Clawd may wear at this moment */
export function skinPool(moment: SkinMoment): ClawdSkin[] {
  return SKINS.filter((s) => WHEN[s.id]?.(moment) ?? true);
}

/** A random skin from the pool, never the one he has on now (when there is a choice) */
export function pickSkin(current: ClawdSkin | null, moment: SkinMoment, random = Math.random): ClawdSkin {
  const pool = skinPool(moment);
  const others = pool.filter((s) => s.id !== current?.id);
  const from = others.length ? others : pool;
  return from[Math.floor(random() * from.length)] ?? CLASSIC_SKIN;
}

/** The usage numbers a skin is picked for */
export interface UsageNumbers {
  session: number;
  weekly: number;
  fable?: number;
  /** A pinned moment (the usage simulator's); a new one picks again for that moment */
  clock?: string | null;
  /** The account the numbers belong to; switching accounts is not a reset */
  profile?: string;
  /** When the 5-hour window resets (ISO), if known */
  reset?: string | null;
}

const HOUR = 3_600_000;

/**
 * Whether the 5-hour window reset between two readings of the same account. A new window ends
 * at least five hours after the old one, so its reset time jumps ahead; this also catches a
 * reset that happened while nobody was looking. Without reset times, the percentage dropping
 * is the only sign.
 */
function windowReset(
  before: { profile?: string; session: number; reset: number | null },
  after: UsageNumbers,
  now: Date,
): boolean {
  if (before.profile !== after.profile) return false;
  const reset = after.reset ? Date.parse(after.reset) : NaN;
  const was = before.reset;
  if (was != null && Number.isFinite(reset)) return reset > was + HOUR;
  if (was != null) return now.getTime() >= was && after.session < before.session;
  return after.session < before.session;
}

export type SkinPicker = (usage: UsageNumbers, now?: Date) => ClawdSkin;

/**
 * A skin picker with a memory of its own. A new skin is picked only when the numbers change, so
 * a failed refresh (no new numbers) leaves him in the one he has. When the 5-hour window resets
 * he puts on the crown.
 */
export function createSkinPicker(): SkinPicker {
  let worn: { key: string; profile?: string; session: number; reset: number | null; skin: ClawdSkin } | null = null;
  return (usage, now = new Date()) => {
    const key = `${usage.profile ?? ''}|${usage.session}|${usage.weekly}|${usage.fable ?? ''}|${usage.clock ?? ''}`;
    if (worn?.key === key) return worn.skin;
    const reset = worn != null && windowReset(worn, usage, now);
    const skin = reset
      ? SKINS.find((s) => s.id === 'crown') ?? CLASSIC_SKIN
      : pickSkin(worn?.skin ?? null, { now, percent: usage.session });
    const resetAt = usage.reset ? Date.parse(usage.reset) : NaN;
    worn = {
      key, profile: usage.profile, session: usage.session,
      reset: Number.isFinite(resetAt) ? resetAt : null, skin,
    };
    return skin;
  };
}

/**
 * The usage popover's skin. Kept outside React so the popover closing and opening again does
 * not change it.
 */
export const skinForUsage = createSkinPicker();

const SKIN_FILES: Record<string, string> = {
  crown: `
---
name: Crown
g: #FBBF24
r: #EF4444
---
.....g...g...g....
.....gg.ggg.gg....
.....ggggggggg....
.....ggrgggrgg....
`,
  tophat: `
---
name: Top hat
k: #4B5563
r: #DC2626
---
......kkkkkkk.....
......kkkkkkk.....
......kkkkkkk.....
......rrrrrrr.....
...kkkkkkkkkkkkk..
`,
  party: `
---
name: Party
p: #EC4899
y: #FDE047
w: #FFFFFF
---
.........w........
........ppp.......
........pyp.......
.......ppppp......
.......yyyyy......
......ppppppp.....
.....ppyyyyypp....
`,
  shades: `
---
name: Shades
top: 1
s: #111827
w: #9CA3AF
---
...sssssssssssss..
...swsss...swsss..
....sss.....sss...
`,
  frost: `
---
name: Frost
body: #93C5FD
eyes: #0C4A6E
w: #F8FAFC
b: #2563EB
---
.........w........
......bbbbbbb.....
....wwwwwwwwwww...
`,
  witch: `
---
name: Witch hat
k: #7C3AED
o: #F97316
---
..........kk......
.........kkk......
........kkkk......
.......kkkkkk.....
.......oooooo.....
...kkkkkkkkkkkkk..
`,
  tired: `
---
name: Tired
body: #BD7F6B
top: 3
d: #3F2A36
p: #7A5156
---
....p.p.....p.p...
....ddd.....ddd...
`,
  santa: `
---
name: Santa hat
r: #DC2626
w: #F8FAFC
---
.............ww...
..........rrrww...
.........rrrr.....
........rrrrr.....
.......rrrrrrr....
......rrrrrrrrr...
...wwwwwwwwwwwww..
`,
  ears: `
---
name: Cat ears
o: #D77757
p: #F9A8D4
---
...o...........o..
...oo.........oo..
...opo.......opo..
...oppo.....oppo..
`,
  bow: `
---
name: Bow
top: -3
b: #EF4444
k: #B91C1C
---
..........bb...bb.
.........bbbb.bbbb
.........bbbbkbbbb
.........bbbb.bbbb
..........bb...bb.
`,
  nerd: `
---
name: Nerd
top: 1
f: #1F2937
w: #F8FAFC
g: #A0FFFFFF
---
...fffff...fffff..
...fg..ffwffg..f..
...f...f...f...f..
...fffff...fffff..
`,
  astronaut: `
---
name: Astronaut
top: -4
w: #F1F5F9
g: #6693C5FD
h: #E6FFFFFF
c: #94A3B8
---
......wwwwwww.....
....wwgggggggww...
...wghhggggggggw..
..wghgggggggggggw.
..wh............w.
..w.............w.
..w.............w.
..w.............w.
..ccccccccccccccc.
`,
  headtie: `
---
name: Head tie
top: -4
r: #DC2626
s: #1E3A8A
k: #991B1B
---
................rr
...............rsr
..............rsr.
...rrsrrrsrrrsrkk.
................r.
................r.
`,
  parka: `
---
name: Orange parka
body: #F97316
top: -2
o: #EA580C
f: #B7804A
d: #78350F
---
....ooooooooooo...
..oofffffffffffoo.
..of...........fo.
..of...........fo.
..of...........fo.
..of...........fo.
...fffffffffffff..
.......d...d......
.......d...d......
`,
  ushanka: `
---
name: Green ushanka
top: -3
g: #22C55E
d: #15803D
---
.....ggggggggg....
...ggggggggggggg..
..ddddddddddddddd.
.dd.............dd
.dd.............dd
..d.............d.
`,
  pompom: `
---
name: Pompom beanie
top: -4
b: #2563EB
r: #DC2626
---
........rr........
.......rrrr.......
....bbbbbbbbbbb...
...rrrrrrrrrrrrr..
`,
  cyanbeanie: `
---
name: Cyan beanie
top: -4
c: #22D3EE
y: #FACC15
---
........yy........
.......yyyy.......
....ccccccccccc...
...yyyyyyyyyyyyy..
`,
  squarepants: `
---
name: Square pants
body: #FDE047
top: 0
h: #CA8A04
w: #F8FAFC
r: #DC2626
k: #1F2937
p: #92400E
---
..........h.......
..................
........h.........
..........h.......
..................
...wwwwwrrrwwwww..
...kkkkkkrkkkkkk..
...ppppppppppppp..
`,
  flowershorts: `
---
name: Flower shorts
body: #F9A8D4
top: -2
p: #F9A8D4
g: #4ADE80
v: #A855F7
---
........pp........
.......pppp.......
..................
..................
..................
..................
..................
..................
...gvgggvgggvggg..
...vgggvgggvgggv..
`,
  redcrab: `
---
name: Red crab
body: #DC2626
top: -4
r: #B91C1C
w: #F8FAFC
k: #141416
---
....wkw.....wkw...
....www.....www...
.....r.......r....
.....r.......r....
`,
  frycook: `
---
name: Fry cook hat
top: -4
w: #F8FAFC
b: #2563EB
g: #CBD5E1
---
.....wwwwwwwww....
.....wwwwbwwww....
.....wwwbbbwww....
....ggggggggggg...
`,
  zombie: `
---
name: Zombie crab
body: #8DA67E
eyes: #450A0A
top: 0
d: #5E7A52
r: #9F1239
b: #3B5B8C
---
.........dd.......
..........d.......
..................
..................
.............r....
............r.r...
...bbbbbbbbbbbbb..
...b.bb..bbb.b.b..
`,
  skeleton: `
---
name: Skeleton crab
body: #E7E5E4
eyes: #141416
top: 0
k: #1C1917
---
..................
..................
......k.....k.....
......k..k..k.....
.....k.k.k.k.k....
...kkkkkk.kkkkkk..
...k...........k..
...kkkkkk.kkkkkk..
`,
  frankenstein: `
---
name: Frankenstein crab
body: #65A30D
top: -2
k: #1C1917
s: #27272A
g: #A1A1AA
j: #292524
w: #E7E5E4
---
...kkkkkkkkkkkkk..
...kkkkkkkkkkkkk..
...k.kk.kkk.kk.k..
.......sssss......
..................
.gg.............gg
..................
..................
...jjjjjwwwjjjjj..
...jjjjjjwjjjjjj..
`,
  dracula: `
---
name: Dracula crab
body: #CFC8DC
eyes: #DC2626
top: 0
k: #3F3F46
c: #4C1D95
r: #B91C1C
w: #F8FAFC
y: #FBBF24
---
...kkkkkkkkkkkkk..
...kk....k....kk..
.c...............c
.cr.............rc
.......w...w......
..................
...ccwwwwywwwwcc..
...ccrwwwwwwwrcc..
`,
  rockerboy: `
---
name: Rockerboy
top: -2
k: #1C1917
g: #D4A017
s: #3B1F0E
h: #F59E0B
c: #E5E7EB
d: #9CA3AF
---
.....kkkkkkkkkk...
...kkkkkkkkkkkkkk.
...k..........kkk.
...ggggggggggggg..
...ghssg...ghssg..
....sss.....sss...
.........k......cc
........kkk.....dc
`,
  netrunner: `
---
name: Netrunner
eyes: #5EF6FF
top: -1
k: #1E1B2E
v: #FF0F172A
c: #5EF6FF
---
....kkkckkkckkk...
..................
..................
..kvvvvvvvvvvvvvk.
..kvcccvvvvvcccvk.
`,
};

/** Every skin: classic first, then the widget's files */
export const SKINS: ClawdSkin[] = [
  CLASSIC_SKIN,
  ...Object.entries(SKIN_FILES)
    .map(([id, raw]) => parseSkin(id, raw))
    .filter((s): s is ClawdSkin => s != null),
];
