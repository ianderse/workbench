/**
 * The sky behind Clawd, following the local time: a tint for night, dawn, day and dusk, the sun
 * and the moon (in its real phase) travelling an arc, and stars at night. The weather follows
 * the 5-hour limit instead of a forecast: from 50% it rains, in winter it snows.
 *
 * Ported from the clawd-usage widget (https://github.com/Enhed/clawd-usage-winwidget,
 * lib/sky.ps1 and lib/weather.ps1). Pure maths, no React.
 */


/** r, g, b and alpha, all 0-255 */
type Rgba = [number, number, number, number];

const hex = (argb: string): Rgba => {
  const n = (i: number) => parseInt(argb.slice(i, i + 2), 16);
  return [n(3), n(5), n(7), n(1)];
};

export const css = ([r, g, b, a]: Rgba): string =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(a / 255).toFixed(3)})`;

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));

export function mix(a: Rgba, b: Rgba, k: number): Rgba {
  const t = clamp01(k);
  return [0, 1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * t) as Rgba;
}

/** Cloud cover: the colour fades toward grey and darkens */
function dim([r, g, b, a]: Rgba, k: number): Rgba {
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  const f = 1 - 0.3 * k;
  return [(r + (l - r) * k) * f, (g + (l - g) * k) * f, (b + (l - b) * k) * f, a];
}

/** The sky's tint at each time of day, from the top of the row to the bottom */
const PALETTE: Record<string, { top: Rgba; bottom: Rgba; light: number }> = {
  night: { top: hex('#00304A8C'), bottom: hex('#1A304A8C'), light: 0 },
  dawn:  { top: hex('#00404E8A'), bottom: hex('#33E08A66'), light: 0.5 },
  day:   { top: hex('#004A8CCB'), bottom: hex('#2E6FA8D8'), light: 1 },
  dusk:  { top: hex('#00383070'), bottom: hex('#33D86A50'), light: 0.5 },
};

const SUN_HIGH = hex('#FFFDE68A');
const SUN_LOW = hex('#FFFB923C');
const CLOUD_DAY = hex('#FFB4B4BC');
const CLOUD_NIGHT = hex('#FF5E5E68');
const CLOUD_RAIN = hex('#FF52525B');

/** December to February */
export function isWinter(now: Date): boolean {
  const month = now.getMonth();
  return month === 11 || month <= 1;
}

/** What falls from the sky, picked by the 5-hour limit */
export interface Weather {
  kind: 'fair' | 'rain' | 'snow';
  /** How overcast, 0-1: hides the sun, the moon and the stars, and greys the sky */
  cover: number;
  /** Clouds per 140px of sky */
  clouds: number;
  /** Drops or flakes per 140px of sky */
  fall: number;
  /** Lightning now and then */
  storm: boolean;
}

/**
 * Fair weather under 50% of the 5-hour limit; above it rain that grows heavier as the limit runs
 * out (a thunderstorm from 90%), or snow in winter.
 */
export function usageWeather(percent: number | null, now: Date): Weather {
  if (percent == null || percent < 50) {
    return { kind: 'fair', cover: 0, clouds: 1.5, fall: 0, storm: false };
  }
  const level = percent >= 90 ? 2 : percent >= 70 ? 1 : 0;
  if (isWinter(now)) {
    const cover = [0.85, 0.85, 0.9][level];
    return { kind: 'snow', cover, clouds: 5 * cover, fall: [6, 10, 14][level], storm: false };
  }
  const cover = [0.8, 0.9, 1][level];
  return { kind: 'rain', cover, clouds: 5 * cover, fall: [6, 12, 16][level], storm: level === 2 };
}

/**
 * Where we roughly are, from the time zone alone (no location is asked for): a mid latitude in
 * whichever hemisphere has summer time in July, and a longitude that puts the sun highest at
 * 12:30 standard time - most zones keep their clocks a little ahead of the sun.
 */
function homePlace(now: Date): { lat: number; lon: number } {
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  return { lat: jan < jul ? -35 : 45, lon: -Math.max(jan, jul) / 4 - 7.5 };
}

/** Sunrise and sunset (NOAA formulas), local minutes from midnight */
export function sunTimes(now: Date): { sr: number; ss: number } {
  const { lat, lon } = homePlace(now);
  const start = Date.UTC(now.getFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - start) / 864e5);
  const gm = (2 * Math.PI / 365) * (day - 0.5);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(gm) - 0.032077 * Math.sin(gm)
    - 0.014615 * Math.cos(2 * gm) - 0.040849 * Math.sin(2 * gm));
  const dec = 0.006918 - 0.399912 * Math.cos(gm) + 0.070257 * Math.sin(gm)
    - 0.006758 * Math.cos(2 * gm) + 0.000907 * Math.sin(2 * gm)
    - 0.002697 * Math.cos(3 * gm) + 0.00148 * Math.sin(3 * gm);
  const la = (lat * Math.PI) / 180;
  const c = Math.cos((90.833 * Math.PI) / 180) / (Math.cos(la) * Math.cos(dec)) - Math.tan(la) * Math.tan(dec);
  // Polar day or night: the sun never sets or never rises
  const ha = (Math.acos(Math.min(0.999, Math.max(-0.999, c))) * 180) / Math.PI;
  const tz = -now.getTimezoneOffset();
  const wrap = (m: number) => ((m % 1440) + 1440) % 1440;
  return { sr: wrap(720 - 4 * (lon + ha) - eq + tz), ss: wrap(720 - 4 * (lon - ha) - eq + tz) };
}

const MOON_MONTH = 29.530588853;

/**
 * Days since the new moon, from how far the Moon is from the Sun along the ecliptic with the
 * main periodic terms (good to about an hour).
 */
export function moonAge(now: Date): number {
  const d = (now.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const rad = Math.PI / 180;
  const g = (357.528 + 0.9856003 * d) * rad;
  const sun = 280.46 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  const lm = 218.316 + 13.176396 * d;
  const mm = (134.963 + 13.064993 * d) * rad;
  const dd = (lm - (280.46 + 0.9856474 * d)) * rad;
  const moon = lm + 6.289 * Math.sin(mm) - 1.274 * Math.sin(2 * dd - mm) + 0.658 * Math.sin(2 * dd)
    - 0.186 * Math.sin(g) - 0.059 * Math.sin(2 * dd - 2 * mm) - 0.057 * Math.sin(2 * dd - mm - g);
  const e = (((moon - sun) % 360) + 360) % 360;
  return (e / 360) * MOON_MONTH;
}

/** The moon as 7x7 pixel art: the lit part and the dark rest of the disc ('#' on, '.' off) */
export function moonArt(now: Date): { lit: string[]; dark: string[] } {
  const th = (2 * Math.PI * moonAge(now)) / MOON_MONTH;
  const k = Math.cos(th);
  const south = homePlace(now).lat < 0;
  const n = 7;
  const r = n / 2;
  const lit: string[] = [];
  const dark: string[] = [];
  for (let y = 0; y < n; y++) {
    let a = '';
    let b = '';
    for (let x = 0; x < n; x++) {
      let u = (x + 0.5 - r) / r;
      const v = (y + 0.5 - r) / r;
      // In the southern hemisphere the waxing moon is lit on the left
      if (south) u = -u;
      const inDisc = u * u + v * v <= 1.05;
      const t = k * Math.sqrt(Math.max(0, 1 - v * v));
      const on = inDisc && (th < Math.PI ? u > t : u < -t);
      a += on ? '#' : '.';
      b += inDisc && !on ? '#' : '.';
    }
    lit.push(a);
    dark.push(b);
  }
  return { lit, dark };
}

export interface SkyLook {
  /** 0 at night, 1 by day */
  light: number;
  top: string;
  bottom: string;
  /** Sun along its arc, 0 at sunrise and 1 at sunset; null below the horizon or behind clouds */
  sun: { p: number; color: string; opacity: number } | null;
  /** Moon along its arc from sunset to sunrise */
  moon: { p: number; opacity: number } | null;
  stars: number;
  /** Cloud colour when the weather turns, null for the usual fair-weather clouds */
  cloud: string | null;
}

/** How the sky looks at this moment in this weather */
export function skyLook(now: Date, weather: Weather): SkyLook {
  const { sr, ss } = sunTimes(now);
  const t = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

  const stops: [number, string][] = [
    [sr - 80, 'night'], [sr - 10, 'dawn'], [sr + 70, 'day'],
    [ss - 70, 'day'], [ss + 10, 'dusk'], [ss + 80, 'night'],
  ];
  let a = PALETTE.night;
  let b = PALETTE.night;
  let k = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t < stops[i + 1][0]) {
      a = PALETTE[stops[i][1]];
      b = PALETTE[stops[i + 1][1]];
      k = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      break;
    }
  }
  const light = a.light + (b.light - a.light) * k;
  const grey = weather.cover * 0.9;

  const vis = Math.max(0, 1 - weather.cover * 1.15);
  const onArc = (p: number) => p >= -0.06 && p <= 1.06;
  const sp = (t - sr) / (ss - sr);
  const mp = ((t - ss + 1440) % 1440) / (sr + 1440 - ss);

  let cloud: string | null = null;
  if (weather.kind !== 'fair') {
    const c = mix(CLOUD_NIGHT, CLOUD_DAY, light);
    cloud = css(weather.kind === 'rain' ? mix(c, CLOUD_RAIN, 0.55) : c);
  }

  return {
    light,
    top: css(dim(mix(a.top, b.top, k), grey)),
    bottom: css(dim(mix(a.bottom, b.bottom, k), grey)),
    sun: vis > 0 && onArc(sp)
      ? { p: sp, color: css(mix(SUN_LOW, SUN_HIGH, Math.sin(Math.PI * sp) * 1.6)), opacity: vis }
      : null,
    moon: vis > 0 && onArc(mp) ? { p: mp, opacity: vis } : null,
    stars: Math.max(0, (1 - light * 2) * Math.max(0, 1 - weather.cover * 1.4)),
    cloud,
  };
}

/** Top-left of a body of size 2*half on the arc across a w x h sky */
export function arcPos(p: number, w: number, h: number, half: number): { x: number; y: number } {
  const alt = Math.sin(Math.PI * p);
  return { x: 7 + p * (w - 14) - half, y: h + 3 - alt * (h - 12) - half };
}

/** A small seeded generator, so the stars and drops land in the same places every time */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
