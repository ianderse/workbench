/**
 * The scene Clawd lives in: a pixel sky across the whole row that follows the local time and the
 * 5-hour limit, with the crab walking along the ground beside the percentage.
 *
 * Everything is drawn as whole pixels, in the same units as the sprite (see ./clawd/sprite.ts),
 * so it stays crisp at any UI scale.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { HEART_FULL } from './clawd/heart';
import {
  CLAWD_FX, CLAWD_SAND, MASCOT_H, MASCOT_SINK,
  type Rect,
} from './clawd/sprite';
import { moonLitPath, seeded, skyBodyPos, skyLook, usageWeather } from './clawd/sky';
import type { ClawdRender } from './clawd/useClawd';
import type { DecorPiece } from './clawd/decor';

/** Height of the scene; the mascot stands on its bottom edge */
export const SCENE_H = 46;
/** The highest the bubble's baseline goes, so its 11px glyph stays inside the scene */
const BUBBLE_MIN_Y = 9;

/** Pixel clouds, two units per pixel, drifting left to right */
const CLOUD_SHAPES = [
  ['....###.....', '..#######...', '.##########.', '############'],
  ['..###...', '.######.', '########'],
  ['...##.##..', '.########.', '##########'],
];
const CLOUD_PX = 2;

/**
 * One cloud: its shape, how high it floats and how long it takes to cross. Fair weather shows
 * the first few; as the sky clouds over, more of them come in.
 */
const CLOUDS = [
  { shape: 0, top: 0.08, dur: 71, delay: -12 },
  { shape: 1, top: 0.30, dur: 53, delay: -37 },
  { shape: 2, top: 0.14, dur: 88, delay: -60 },
  { shape: 1, top: 0.02, dur: 64, delay: -24 },
  { shape: 0, top: 0.34, dur: 97, delay: -75 },
  { shape: 2, top: 0.22, dur: 77, delay: -5 },
  { shape: 0, top: 0.0, dur: 59, delay: -44 },
  { shape: 1, top: 0.18, dur: 83, delay: -66 },
  { shape: 2, top: 0.06, dur: 68, delay: -30 },
];

/** Pixel art ('#' on) as merged rectangles, px units per pixel */
function artRects(rows: string[], px: number): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < rows.length; y++) {
    let x = 0;
    while (x < rows[y].length) {
      if (rows[y][x] !== '#') { x++; continue; }
      const x0 = x;
      while (x < rows[y].length && rows[y][x] === '#') x++;
      out.push({ x: x0 * px, y: y * px, w: (x - x0) * px, h: px });
    }
  }
  return out;
}
const CLOUD_RECTS = CLOUD_SHAPES.map((rows) => artRects(rows, CLOUD_PX));
/** A cloud's flat underside (its bottom row), drawn in a shade so it stands out on a pale sky */
const CLOUD_BASE_Y = CLOUD_SHAPES.map((rows) => (rows.length - 1) * CLOUD_PX);
const CLOUD_W = CLOUD_SHAPES.map((rows) => rows[0].length * CLOUD_PX);

/** Radius of the sun and the moon */
const BODY_R = 4.5;
/** The sunlit part of the moon, pale gold */
const MOON_LIT = '#F3E6B8';

/** Top and bottom fade alike, so the sky leaves the same small gap under the header as over the bar */
const FADE_Y: [number, number][] = [
  [0, 0.1], [0.08, 0.5], [0.2, 1], [0.8, 1], [0.92, 0.5], [1, 0.1],
];

/** How far apart (px) the steps of an edge mask's side fade are, too close to show */
const MASK_STEP_PX = 0.5;

/** The standard normal distribution (Abramowitz and Stegun's erf, 7.1.26) */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z < 0 ? (1 - erf) / 2 : (1 + erf) / 2;
}

/**
 * The side fade's steps ([inset, opacity]): an edge blurred around a line two fifths in, over
 * SIDE_FADE pixels from the sky's side, in full from there
 */
function sideSteps(): [number, number][] {
  const soft = SIDE_FADE / 5;
  const steps: [number, number][] = [];
  for (let x = MASK_STEP_PX; x < SIDE_FADE; x += MASK_STEP_PX) {
    steps.push([x, normalCdf((x - 2 * soft) / soft)]);
  }
  steps.push([SIDE_FADE, 1]);
  return steps;
}

/** Where opacity v is first reached along a fade's stops ([y, opacity], in order) */
function firstAt(stops: [number, number][], v: number): number {
  if (v <= stops[0][1]) return stops[0][0];
  for (let i = 1; i < stops.length; i++) {
    const [y0, a0] = stops[i - 1];
    const [y1, a1] = stops[i];
    if (a1 >= v && a0 < v) return y0 + ((v - a0) / (a1 - a0)) * (y1 - y0);
  }
  return stops[stops.length - 1][0];
}

/** How round the corners of the part of the sky that shows in full are (px) */
const MASK_CORNER = 4;

/** A rectangle with round corners, rTop at the top and rBottom at the bottom */
function roundedRectPath(x: number, y: number, width: number, height: number, rTop: number, rBottom: number): string {
  const scale = Math.min(1, height / Math.max(rTop + rBottom, 1e-6));
  const t = Math.min(rTop * scale, width / 2);
  const u = Math.min(rBottom * scale, width / 2);
  const r = x + width;
  const b = y + height;
  return `M ${x + t} ${y} H ${r - t} A ${t} ${t} 0 0 1 ${r} ${y + t} V ${b - u} `
    + `A ${u} ${u} 0 0 1 ${r - u} ${b} H ${x + u} A ${u} ${u} 0 0 1 ${x} ${b - u} `
    + `V ${y + t} A ${t} ${t} 0 0 1 ${x + t} ${y} Z`;
}

interface MaskLevel { d: string; opacity: number }

/**
 * An edge mask as nested rounded rectangles, one per step of the side fade, each as far in from
 * the sides as the side fade and from the top and bottom as their fades (fadeY, offsets of the
 * height; none for the sides only). So the sides fade the same way all the way up and down, and
 * the corners round off from one fade into the other in circles, MASK_CORNER for the full part
 * and as much larger as the top or bottom fade is long.
 */
function edgeMask(w: number, h: number, fadeY: [number, number][] | null): MaskLevel[] {
  const down = fadeY?.map(([o, a]): [number, number] => [o * h, a]);
  const up = down && [...down].reverse().map(([y, a]): [number, number] => [h - y, a]);
  const steps = sideSteps();
  // Where each fade is in full
  const fullTop = down ? firstAt(down, 1) : 0;
  const fullBottom = up ? firstAt(up, 1) : 0;
  const corner = fadeY ? MASK_CORNER : 0;
  const levels: MaskLevel[] = [];
  let shown = 0;
  for (const [x, v] of steps) {
    const top = down ? firstAt(down, v) : 0;
    const bottomInset = up ? firstAt(up, v) : 0;
    const width = w - 2 * x;
    const height = h - bottomInset - top;
    if (width <= 0 || height <= 0) break;
    // Round corners, as wide as they are tall: they follow the top and bottom fades
    const d = roundedRectPath(x, top, width, height, corner + fullTop - top, corner + fullBottom - bottomInset);
    // Each rectangle over the ones before it raises what shows inside it to v
    levels.push({ d, opacity: (v - shown) / (1 - shown) });
    shown = v;
  }
  return levels;
}

/** How long the sky's side fades are (px) */
const SIDE_FADE = 12;
/**
 * How far the sky reaches past its row: half its side fade past each end of the bar, so the
 * fade sits around the bar's ends, and up through the gap to the header
 */
const SKY_BLEED_X = SIDE_FADE / 2 - 2;
const SKY_BLEED_TOP = 10;
/** Down behind the top half of the 8px progress bar, so the sky ends at the bar's middle */
const SKY_BLEED_BOTTOM = 4;
/**
 * How long the top and bottom fades of the sky's background and of its clouds are (px): short,
 * so they are in full just under the header, where the highest clouds float, and down to
 * just over the bar
 */
const BG_FADE = 4;

/**
 * Opacity down the sky's background and its clouds: the sky's own fades squeezed into BG_FADE
 * pixels, the bottom one ending at the bar's top edge (the sky reaches on behind the bar)
 */
function backgroundFadeY(h: number): [number, number][] {
  const ground = h - SKY_BLEED_BOTTOM;
  const topEnd = FADE_Y.find(([o, a]) => o < 0.5 && a === 1)?.[0] ?? 0.2;
  const top = FADE_Y.filter(([o]) => o < 0.5);
  const fade = (o: number) => (o / topEnd) * BG_FADE;
  return [
    ...top.map(([o, a]): [number, number] => [fade(o) / h, a]),
    ...[...top].reverse().map(([o, a]): [number, number] => [(ground - fade(o)) / h, a]),
    [1, top[0][1]],
  ];
}

/** Weather counts are tuned for a 140px strip; a wider sky gets more */
const DENSITY_W = 140;

/** Stars, drops and flakes in fixed places, so the sky does not reshuffle every time it opens */
const rand = seeded(20261026);
const STARS = Array.from({ length: 20 }, () => ({
  fx: rand(), fy: rand() * 0.6, dur: 1.6 + 1.8 * rand(), delay: -4 * rand(),
}));
const DROPS = Array.from({ length: 40 }, () => ({
  fx: rand() * 1.08 - 0.06, fy: rand(), dur: 0.55 + 0.3 * rand(), delay: -2 * rand(),
}));
const FLAKES = Array.from({ length: 34 }, () => ({
  fx: rand(), fy: rand(), dur: 7 + 5 * rand(), delay: -12 * rand(), sway: 1.6 + 1.2 * rand(),
}));

function Pixels({ rects, fill, opacity }: { rects: Rect[]; fill: string; opacity?: number }) {
  return (
    <>
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} opacity={opacity} />
      ))}
    </>
  );
}

/** Measure an element and keep its width */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * The current time, moved on every minute so the sun and the moon keep travelling, or a pinned
 * moment (the usage simulator's) that holds still
 */
export function useMinute(pinned: Date | null): Date {
  const [real, setReal] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setReal(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return pinned ?? real;
}

/**
 * The sky, drawn across the whole row behind both the percentage and the mascot, fading out at
 * either edge so the clouds drift in and out of nothing. It follows the local time - a tint for
 * night, dawn, day and dusk, the sun and the moon on their arc, stars at night - and the 5-hour
 * limit brings the weather: rain from 50%, snow in winter.
 */
export function ClawdSky({ percent, pinned = null }: { percent: number | null; pinned?: Date | null }) {
  const [ref, w] = useWidth();
  const now = useMinute(pinned);
  // The preview in Settings can show a second sky; each one needs its own gradient and mask ids
  const uid = useId().replace(/:/g, '');
  const id = (name: string) => `clawd-${name}-${uid}`;
  const weather = useMemo(() => usageWeather(percent, now), [percent, now]);
  const look = useMemo(() => skyLook(now, weather), [now, weather]);
  // Some clouds are thick enough to hide the sun or the moon; which ones changes each time the
  // sky opens, so a passing cloud only sometimes covers them
  const [thick] = useState(() => CLOUDS.map(() => Math.random() < 0.5));

  // The ground (the bar's top edge): the clouds, stars and falling weather are laid out above it
  const ground = SCENE_H + SKY_BLEED_TOP;
  const h = ground + SKY_BLEED_BOTTOM;
  const density = Math.max(1, w / DENSITY_W);
  const clouds = Math.min(CLOUDS.length, Math.round(weather.clouds * density));
  const fall = Math.round(weather.fall * density);
  // The sky grew upward, so the sun and the moon come down with the clouds' band
  const lower = (pos: { cx: number; cy: number }) => ({ cx: pos.cx, cy: pos.cy + SKY_BLEED_TOP / 2 });
  const sun = look.sun && lower(skyBodyPos(look.sun.p, w));
  const moonAt = look.moon && lower(skyBodyPos(look.moon.p, w));
  const masks = useMemo(() => ({
    background: edgeMask(w, h, backgroundFadeY(h)),
    sky: edgeMask(w, h, FADE_Y),
    sides: edgeMask(w, h, null),
  }), [w, h]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute"
      style={{ left: -SKY_BLEED_X, right: -SKY_BLEED_X, top: -SKY_BLEED_TOP, bottom: -SKY_BLEED_BOTTOM }}
    >
      {w > 0 && (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          shapeRendering="crispEdges"
          className="absolute inset-0 overflow-hidden"
          aria-hidden="true"
        >
          <defs>
            {/* Eased fades on every side, so the sky melts into the popover in either theme
                instead of ending in an edge: the same soft edge on both sides, the sky's own fade
                at the top and bottom, and a short one for the background and the clouds */}
            {([
              ['sky-mask-y-bg', masks.background],
              ['sky-mask-y', masks.sky],
              ['sky-mask-sides', masks.sides],
            ] as const).map(([name, levels]) => (
              <mask key={name} id={id(name)} maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
                {levels.map((level, i) => (
                  <path key={i} d={level.d} fill="#fff" opacity={level.opacity} shapeRendering="geometricPrecision" />
                ))}
              </mask>
            ))}
            {/* The sky's own colour for the time of day */}
            <linearGradient id={id('sky-tint')} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={look.top} />
              <stop offset="1" stopColor={look.bottom} />
            </linearGradient>
            <radialGradient id={id('sun-glow')}>
              <stop offset="0" stopColor={look.sun?.color ?? '#FACC15'} stopOpacity="0.45" />
              <stop offset="1" stopColor={look.sun?.color ?? '#FACC15'} stopOpacity="0" />
            </radialGradient>
            <radialGradient id={id('moon-glow')}>
              <stop offset="0" stopColor={MOON_LIT} stopOpacity="0.3" />
              <stop offset="1" stopColor={MOON_LIT} stopOpacity="0" />
            </radialGradient>
          </defs>
          {/* The sky's own background, whatever the app's theme: the dark popover with the light
              one over it, as light as the day (the rest of the card stays in the theme) */}
          <g mask={`url(#${id('sky-mask-y-bg')})`}>
            <rect x="0" y="0" width={w} height={h} className="dark fill-popover" />
            <rect x="0" y="0" width={w} height={h} className="light fill-popover" opacity={look.light} />

            {/* The sky's colour, with the background's fades so it covers it out to its edges. Half
                strength over the white popover; stronger over the dark one, which would otherwise
                dull a day sky into dusk */}
            <rect
              x="0" y="0" width={w} height={h} fill={`url(#${id('sky-tint')})`}
              className="[fill-opacity:0.5] dark:[fill-opacity:0.8]"
            />
          </g>

          <g mask={`url(#${id('sky-mask-y')})`}>
            {/* Stars twinkle at night */}
            {look.stars > 0 && (
              <g opacity={look.stars}>
                {STARS.map((s, i) => (
                  <rect
                    key={i}
                    x={Math.round(s.fx * (w - 2))} y={Math.round(2 + s.fy * ground)}
                    width={1.2} height={1.2} fill="#F8FAFC"
                    className="clawd-star"
                    style={{ animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }}
                  />
                ))}
              </g>
            )}

            {/* The moon in its real phase, from sunset to sunrise: pale gold where the sun
                lights it, the rest of the disc a dim slate. True circles, so it reads as a moon. */}
            {look.moon && moonAt && (
              <g opacity={look.moon.opacity} shapeRendering="geometricPrecision">
                <circle cx={moonAt.cx} cy={moonAt.cy} r={BODY_R * 2.2} fill={`url(#${id('moon-glow')})`} />
                <circle cx={moonAt.cx} cy={moonAt.cy} r={BODY_R} fill="#64748B" opacity={0.45} />
                <path d={moonLitPath(now, moonAt.cx, moonAt.cy, BODY_R)} fill={MOON_LIT} />
              </g>
            )}

            {/* The sun by day, yellow high up and orange near the horizon */}
            {look.sun && sun && (
              <g opacity={look.sun.opacity} shapeRendering="geometricPrecision">
                <circle cx={sun.cx} cy={sun.cy} r={BODY_R * 2.4} fill={`url(#${id('sun-glow')})`} />
                <circle cx={sun.cx} cy={sun.cy} r={BODY_R} fill={look.sun.color} />
              </g>
            )}
          </g>

          {/* The clouds fade in and out as briefly as the background, so the highest ones show */}
          <g mask={`url(#${id('sky-mask-y-bg')})`}>
            {/* Clouds drift past in front of the sun and the moon. Thick ones are solid and hide
                them; which ones are thick changes each time the sky opens. */}
            {CLOUDS.slice(0, clouds).map((c, i) => (
              <g
                key={i}
                className="motion-safe:[animation:clawd-cloud-drift_linear_infinite]"
                style={{
                  animationDuration: `${c.dur}s`,
                  animationDelay: `${c.delay}s`,
                  ['--clawd-cloud-from' as string]: `${-CLOUD_W[c.shape]}px`,
                  ['--clawd-cloud-to' as string]: `${w}px`,
                }}
              >
                <g transform={`translate(0 ${Math.round(c.top * ground)})`}>
                  <g opacity={thick[i] ? 1 : weather.kind === 'fair' ? 0.85 : 0.75}>
                    <Pixels
                      rects={CLOUD_RECTS[c.shape].filter((r) => r.y < CLOUD_BASE_Y[c.shape])}
                      fill={look.cloud}
                    />
                    <Pixels
                      rects={CLOUD_RECTS[c.shape].filter((r) => r.y >= CLOUD_BASE_Y[c.shape])}
                      fill={look.cloudShade}
                    />
                  </g>
                </g>
              </g>
            ))}
          </g>

          <g mask={`url(#${id('sky-mask-y')})`}>
            {/* Rain, slanting a little with the wind */}
            {weather.kind === 'rain' && DROPS.slice(0, Math.min(DROPS.length, fall)).map((d, i) => (
              <rect
                key={i}
                x={Math.round(d.fx * w)} y={0} width={1} height={3.5}
                className="clawd-drop" fill="#BFDBFE" opacity={0.75}
                // Anti-aliased, so a drop keeps its size while it moves by sub-pixels
                shapeRendering="geometricPrecision"
                style={{
                  animationDuration: `${d.dur}s`,
                  animationDelay: `${d.delay}s`,
                  ['--clawd-y0' as string]: `${Math.round(d.fy * ground)}px`,
                  ['--clawd-fall' as string]: `${h + 4}px`,
                }}
              />
            ))}

            {/* Snow falls slowly and sways */}
            {weather.kind === 'snow' && FLAKES.slice(0, Math.min(FLAKES.length, fall)).map((f, i) => (
              <g
                key={i}
                className="clawd-flake"
                shapeRendering="geometricPrecision"
                style={{
                  animationDuration: `${f.dur}s`,
                  animationDelay: `${f.delay}s`,
                  ['--clawd-y0' as string]: `${Math.round(f.fy * ground)}px`,
                  ['--clawd-fall' as string]: `${h + 2}px`,
                }}
              >
                <rect
                  x={Math.round(f.fx * w)} y={0} width={1.6} height={1.6}
                  fill="#F8FAFC" opacity={0.9}
                  className="clawd-flake-sway"
                  style={{ animationDuration: `${f.sway}s`, animationDelay: `${f.delay}s` }}
                />
              </g>
            ))}

            {/* A thunderstorm flashes now and then, sometimes twice in a row */}
            {weather.storm && (
              <rect x="0" y="0" width={w} height={h} fill="#F8FAFC" className="clawd-flash" />
            )}
          </g>

          {/* Settled snow: a thin strip on the ground, outside the bottom fade so it stays */}
          {weather.kind === 'snow' && (
            <rect
              x={0} y={ground - 1.5} width={w} height={1.5} fill="#E2E8F0" opacity={0.6 + 0.3 * look.light}
              mask={`url(#${id('sky-mask-sides')})`}
            />
          )}
        </svg>
      )}
    </div>
  );
}

interface ClawdSceneProps {
  render: ClawdRender | null;
  /** The scene reports how wide it is, so Clawd knows how far he may walk */
  onSpan: (span: number) => void;
  /** Pointer x inside the scene, or null when it leaves; Clawd follows it */
  onPointer: (x: number | null) => void;
  /** Petting him */
  onPet: () => void;
  /** Holiday decorations standing on the ground behind him */
  decor?: DecorPiece[];
}

/** The ground Clawd walks on, beside the percentage */
export function ClawdScene({ render, onSpan, onPointer, onPet, decor = [] }: ClawdSceneProps) {
  const [ref, w] = useWidth();

  useEffect(() => { onSpan(w); }, [w, onSpan]);

  const handleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (box) onPointer(e.clientX - box.left);
  }, [onPointer, ref]);

  const handleLeave = useCallback(() => onPointer(null), [onPointer]);

  const bubbleColor = render?.bubbleKind === 'cheer' ? '#4ADE80'
    : '#93C5FD';

  // The mascot box sits on the ground, minus the empty lower half-row, plus however far he has
  // jumped; everything else is placed from the bottom edge of the scene the same way.
  const mascotTop = render ? SCENE_H - MASCOT_H + MASCOT_SINK - render.lift : 0;
  const fromBottom = (y: number) => SCENE_H - y;
  // The "!" and the notes float above his hat when he wears one, never across it
  const hatTop = render
    ? render.geo.acc.reduce((top, layer) => layer.rects.reduce((t, r) => Math.min(t, r.y), top), Infinity)
    : Infinity;
  const bubbleBase = render
    ? Math.max(BUBBLE_MIN_Y, Math.min(fromBottom(render.bubbleY), mascotTop + hatTop - 1.5))
    : 0;

  return (
    <div
      ref={ref}
      className="relative h-full flex-1 cursor-pointer select-none"
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      onClick={onPet}
    >
      {w > 0 && render && (
        <svg
          width={w}
          height={SCENE_H}
          viewBox={`0 0 ${w} ${SCENE_H}`}
          shapeRendering="crispEdges"
          className="absolute inset-0 overflow-hidden text-muted-foreground"
          aria-hidden="true"
        >
          {/* Pumpkins or presents on the ground, behind him so he walks in front of them */}
          {decor.map((d, i) => (
            <g key={`decor-${i}`} transform={`translate(${Math.round(d.at * Math.max(0, w - d.w))} ${SCENE_H - d.h})`}>
              {d.layers.map((layer) => (
                <Pixels key={layer.color} rects={layer.rects} fill={layer.color} />
              ))}
            </g>
          ))}

          {/* Confetti, dust and the heart live in scene coordinates */}
          {render.confetti.map((c, i) => (
            <rect
              key={`conf-${i}`}
              x={c.x} y={fromBottom(c.y)} width={c.w} height={2.5}
              fill={c.color} opacity={c.opacity}
            />
          ))}
          {render.dust.map((d, i) => (
            <rect key={`dust-${i}`} x={d.x} y={fromBottom(d.y) - 2} width={2} height={2}
                  fill={CLAWD_FX} opacity={d.opacity} />
          ))}

          {/* Clawd himself */}
          <g transform={`translate(${Math.round(render.x)} ${mascotTop})`}>
            <Pixels rects={render.geo.sand} fill={CLAWD_SAND} />
            <Pixels rects={render.geo.body} fill={render.skin.body} />
            <Pixels rects={render.geo.eyes} fill={render.skin.eyes} />
            {render.geo.acc.map((layer, i) => (
              <Pixels key={`acc-${i}`} rects={layer.rects} fill={layer.color} />
            ))}
            <Pixels rects={render.geo.fx} fill={CLAWD_FX} />
          </g>

          {/* Sweat runs down the side of his head while the limit burns */}
          {render.sweat && (
            <rect
              x={render.sweat.x} y={mascotTop + render.sweat.y}
              width={3} height={4.5} fill="#7DD3FC" opacity={render.sweat.opacity}
            />
          )}

          {/* The soul leaving the body, once the limit is spent and you poke him */}
          {render.soul && (
            <g transform={`translate(${render.soul.x} ${fromBottom(render.soul.y)})`}
               opacity={render.soul.opacity}>
              <Pixels rects={render.soul.rects} fill="#F4F4F5" />
            </g>
          )}

          {/* A heart floats up when he is petted */}
          {render.love && (
            <g transform={`translate(${render.love.x} ${fromBottom(render.love.y)})`}
               opacity={render.love.opacity}>
              <Pixels rects={HEART_FULL} fill="#F87171" />
            </g>
          )}

          {/* "z"s while he sleeps */}
          {render.zzz && (
            <text
              x={render.zzz.x} y={fromBottom(render.zzz.y)}
              fontSize={render.zzz.size} fontWeight={600}
              opacity={render.zzz.opacity} fill="currentColor"
            >
              z
            </text>
          )}

          {/* "!" when the window resets, notes while he whistles */}
          {render.bubble && (
            <text
              x={render.x + 18} y={bubbleBase}
              fontSize={11} fontWeight={700} textAnchor="middle" fill={bubbleColor}
            >
              {render.bubble}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}
