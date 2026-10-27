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

/**
 * The sky's colour at each time of day, from the top of the row to the bottom. Solid and the
 * same in either app theme - a night sky is dark and a day sky blue whatever the popover is; the
 * scene fades its edges into the popover instead.
 */
const PALETTE: Record<string, { top: Rgba; bottom: Rgba; light: number }> = {
  night: { top: hex('#FF0A1228'), bottom: hex('#FF1C2B52'), light: 0 },
  dawn:  { top: hex('#FF28366A'), bottom: hex('#FFE7946C'), light: 0.5 },
  // Saturated, so at half opacity it still reads as a blue sky over a white or a dark popover
  day:   { top: hex('#FF1F6FD6'), bottom: hex('#FF4FA3EC'), light: 1 },
  dusk:  { top: hex('#FF2A2452'), bottom: hex('#FFD8704E'), light: 0.5 },
};

const SUN_HIGH = hex('#FFFACC15');
const SUN_LOW = hex('#FFFB923C');
const CLOUD_DAY = hex('#FFF1F5F9');
const CLOUD_NIGHT = hex('#FF475069');
const CLOUD_RAIN = hex('#FF4B5563');
const CLOUD_SNOW = hex('#FF94A3B8');
/** The shaded underside of a cloud */
const CLOUD_SHADE = hex('#FF64748B');

/** Time zones south of the equator; most have no summer time to tell them apart by. ICU names
 *  five Argentine zones by their old America/<city> names */
const SOUTH_ZONES = /^(Australia|Antarctica)\/|^America\/(Argentina\/\w+|Buenos_Aires|Cordoba|Catamarca|Jujuy|Mendoza|Sao_Paulo|Santiago|Punta_Arenas|Montevideo|Asuncion|La_Paz|Lima|Cuiaba|Campo_Grande|Porto_Velho|Rio_Branco|Bahia|Maceio|Recife|Araguaina|Fortaleza|Belem|Noronha)$|^Africa\/(Johannesburg|Maputo|Harare|Lusaka|Windhoek|Gaborone|Maseru|Mbabane|Blantyre|Lubumbashi|Luanda|Dar_es_Salaam|Kinshasa|Kigali|Bujumbura)$|^Indian\/(Antananarivo|Mauritius|Reunion|Mayotte|Comoro)$|^Pacific\/(Auckland|Chatham|Fiji|Tongatapu|Apia|Noumea|Efate|Port_Moresby|Tahiti|Rarotonga|Pago_Pago|Easter|Norfolk|Guadalcanal)$|^Asia\/(Jakarta|Makassar|Jayapura|Dili)$/;

function zoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** South of the equator: by the time zone's name, or by summer time falling in January */
export function isSouthern(now: Date): boolean {
  if (SOUTH_ZONES.test(zoneName())) return true;
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  return jan < jul;
}

/**
 * The month (1-12) as the seasons go in the north: south of the equator the seasons are half a
 * year apart, so January there is July here.
 */
export function seasonMonth(now: Date): number {
  const m = now.getMonth();
  return (isSouthern(now) ? (m + 6) % 12 : m) + 1;
}

/** December to February in the north, June to August in the south */
export function isWinter(now: Date): boolean {
  const month = seasonMonth(now);
  return month === 12 || month <= 2;
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

/** December 20 to January 1 */
export function isWinterHolidays(now: Date): boolean {
  const month = now.getMonth();
  const day = now.getDate();
  return (month === 11 && day >= 20) || (month === 0 && day === 1);
}

/**
 * Fair weather under 50% of the 5-hour limit; above it rain that grows heavier as the limit runs
 * out (a thunderstorm from 90%), or snow in winter. Over the winter holidays it always snows:
 * a few flakes under the sun or the moon, then a heavy snowfall from 50%.
 */
export function usageWeather(percent: number | null, now: Date): Weather {
  if (isWinterHolidays(now)) {
    if (percent == null || percent < 50) {
      return { kind: 'snow', cover: 0.3, clouds: 2.5, fall: 5, storm: false };
    }
    const heavy = percent >= 90 ? 2 : percent >= 70 ? 1 : 0;
    const cover = [0.85, 0.9, 0.9][heavy];
    return { kind: 'snow', cover, clouds: 5 * cover, fall: [14, 18, 22][heavy], storm: false };
  }
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
 * the zone's hemisphere, and a longitude that puts the sun highest at 12:30 standard time - most
 * zones keep their clocks a little ahead of the sun.
 */
function homePlace(now: Date): { lat: number; lon: number } {
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  return { lat: isSouthern(now) ? -35 : 45, lon: -Math.max(jan, jul) / 4 - 7.5 };
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
 * main periodic terms (good to well under an hour).
 */
export function moonAge(now: Date): number {
  const d = (now.getTime() - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const rad = Math.PI / 180;
  const g = (357.528 + 0.9856003 * d) * rad;
  const sun = 280.46 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  const lm = 218.316 + 13.176396 * d;
  const mm = (134.963 + 13.064993 * d) * rad;
  const dd = (lm - (280.46 + 0.9856474 * d)) * rad;
  const moon = lm + 6.289 * Math.sin(mm) + 1.274 * Math.sin(2 * dd - mm) + 0.658 * Math.sin(2 * dd)
    + 0.214 * Math.sin(2 * mm) - 0.186 * Math.sin(g) + 0.059 * Math.sin(2 * dd - 2 * mm)
    + 0.057 * Math.sin(2 * dd - mm - g);
  const e = (((moon - sun) % 360) + 360) % 360;
  return (e / 360) * MOON_MONTH;
}

/**
 * The lit part of the moon as an SVG path on a disc of radius r around (cx, cy): half the rim on
 * the lit side, then back along the terminator, an ellipse as wide as the phase is thin.
 */
export function moonLitPath(now: Date, cx: number, cy: number, r: number): string {
  const th = (2 * Math.PI * moonAge(now)) / MOON_MONTH;
  const k = Math.cos(th);
  // Waxing is lit on the right, waning on the left; the southern hemisphere sees it mirrored
  let side = th < Math.PI ? 1 : -1;
  if (isSouthern(now)) side = -side;
  // Where the terminator bulges: toward the lit side for a crescent, away from it past half
  const rx = Math.abs(k) * r;
  const termRight = side * k > 0;
  const top = `${cx} ${cy - r}`;
  const bottom = `${cx} ${cy + r}`;
  return `M ${top} A ${r} ${r} 0 0 ${side > 0 ? 1 : 0} ${bottom} `
    + `A ${rx} ${r} 0 0 ${termRight ? 0 : 1} ${top} Z`;
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
  /** Cloud colour: white by day, slate at night, greyer in rain and snow */
  cloud: string;
  /** The clouds' shaded underside, so a white cloud still stands out on a pale sky */
  cloudShade: string;
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

  const fair = mix(CLOUD_NIGHT, CLOUD_DAY, light);
  const cloudRgba = weather.kind === 'rain' ? mix(fair, CLOUD_RAIN, 0.55)
    : weather.kind === 'snow' ? mix(fair, CLOUD_SNOW, 0.35)
    : fair;
  const cloud = css(cloudRgba);
  const cloudShade = css(mix(cloudRgba, CLOUD_SHADE, 0.35));

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
    cloudShade,
  };
}

/**
 * Centre of the sun or the moon, p of the way along its arc (0 rising, 1 setting), in a sky w
 * wide. They travel inside the band the clouds float in: low at the ends of the arc, highest in
 * the middle, and never into the faded edges.
 */
export function skyBodyPos(p: number, w: number): { cx: number; cy: number } {
  const alt = Math.sin(Math.PI * clamp01(p));
  return { cx: w * (0.16 + 0.68 * clamp01(p)), cy: 15 - 8 * alt };
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
