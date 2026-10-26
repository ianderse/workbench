/**
 * The scene Clawd lives in: a pixel sky across the whole row that follows the local time and the
 * 5-hour limit, with the crab walking along the ground beside the percentage.
 *
 * Everything is drawn as whole pixels, in the same units as the sprite (see ./clawd/sprite.ts),
 * so it stays crisp at any UI scale.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HEART_FULL } from './clawd/heart';
import {
  CLAWD_BODY, CLAWD_EYE, CLAWD_FX, CLAWD_SAND, MASCOT_H, MASCOT_SINK,
  type Rect,
} from './clawd/sprite';
import { arcPos, moonArt, seeded, skyLook, usageWeather } from './clawd/sky';
import type { ClawdRender } from './clawd/useClawd';

/** Height of the scene; the mascot stands on its bottom edge */
export const SCENE_H = 46;

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
const CLOUD_W = CLOUD_SHAPES.map((rows) => rows[0].length * CLOUD_PX);

const SUN_PX = 1.4;
const SUN_RECTS = artRects(['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'], SUN_PX);
const MOON_PX = 1.3;

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

/** The current time, moved on every minute so the sun and the moon keep travelling */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The sky, drawn across the whole row behind both the percentage and the mascot, fading out at
 * either edge so the clouds drift in and out of nothing. It follows the local time - a tint for
 * night, dawn, day and dusk, the sun and the moon on their arc, stars at night - and the 5-hour
 * limit brings the weather: rain from 50%, snow in winter.
 */
export function ClawdSky({ percent }: { percent: number | null }) {
  const [ref, w] = useWidth();
  const now = useMinute();
  const weather = useMemo(() => usageWeather(percent, now), [percent, now]);
  const look = useMemo(() => skyLook(now, weather), [now, weather]);
  const moon = useMemo(() => {
    const art = moonArt(now);
    return { lit: artRects(art.lit, MOON_PX), dark: artRects(art.dark, MOON_PX) };
  }, [now]);

  const h = SCENE_H;
  const density = Math.max(1, w / DENSITY_W);
  const clouds = Math.min(CLOUDS.length, Math.round(weather.clouds * density));
  const fall = Math.round(weather.fall * density);
  const sun = look.sun && arcPos(look.sun.p, w, h, (7 * SUN_PX) / 2);
  const moonAt = look.moon && arcPos(look.moon.p, w, h, (7 * MOON_PX) / 2);

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 text-muted-foreground">
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
            <linearGradient id="clawd-sky-fade" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.12" stopColor="#fff" stopOpacity="1" />
              <stop offset="0.88" stopColor="#fff" stopOpacity="1" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            {/* The sky's tint for the time of day, clear at the top and strongest at the ground */}
            <linearGradient id="clawd-sky-tint" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={look.top} />
              <stop offset="1" stopColor={look.bottom} />
            </linearGradient>
            <radialGradient id="clawd-sun-glow">
              <stop offset="0" stopColor="#FDE68A" stopOpacity="0.25" />
              <stop offset="1" stopColor="#FDE68A" stopOpacity="0" />
            </radialGradient>
            <mask id="clawd-sky-mask">
              <rect x="0" y="0" width={w} height={h} fill="url(#clawd-sky-fade)" />
            </mask>
          </defs>
          <g mask="url(#clawd-sky-mask)">
            <rect x="0" y="0" width={w} height={h} fill="url(#clawd-sky-tint)" />

            {/* Stars twinkle at night */}
            {look.stars > 0 && (
              <g opacity={look.stars} className="text-slate-400 dark:text-slate-50">
                {STARS.map((s, i) => (
                  <rect
                    key={i}
                    x={Math.round(s.fx * (w - 2))} y={Math.round(2 + s.fy * h)}
                    width={1.2} height={1.2} fill="currentColor"
                    className="clawd-star"
                    style={{ animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s` }}
                  />
                ))}
              </g>
            )}

            {/* The moon in its real phase, from sunset to sunrise */}
            {look.moon && moonAt && (
              <g
                transform={`translate(${moonAt.x} ${moonAt.y})`}
                opacity={look.moon.opacity}
                className="text-slate-500 dark:text-slate-100"
              >
                <Pixels rects={moon.dark} fill="currentColor" opacity={0.18} />
                <Pixels rects={moon.lit} fill="currentColor" />
              </g>
            )}

            {/* The sun by day, orange near the horizon */}
            {look.sun && sun && (
              <g opacity={look.sun.opacity}>
                <circle cx={sun.x + 4.9} cy={sun.y + 4.9} r={10} fill="url(#clawd-sun-glow)" />
                <g transform={`translate(${sun.x} ${sun.y})`}>
                  <Pixels rects={SUN_RECTS} fill={look.sun.color} />
                </g>
              </g>
            )}

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
                <g transform={`translate(0 ${Math.round(c.top * h)})`}>
                  {look.cloud
                    ? <Pixels rects={CLOUD_RECTS[c.shape]} fill={look.cloud} opacity={0.65} />
                    : <Pixels rects={CLOUD_RECTS[c.shape]} fill="currentColor" opacity={0.28} />}
                </g>
              </g>
            ))}

            {/* Rain, slanting a little with the wind */}
            {weather.kind === 'rain' && DROPS.slice(0, Math.min(DROPS.length, fall)).map((d, i) => (
              <rect
                key={i}
                x={Math.round(d.fx * w)} y={0} width={1} height={3.5}
                className="clawd-drop text-sky-500 dark:text-blue-300"
                fill="currentColor" opacity={0.55}
                style={{
                  animationDuration: `${d.dur}s`,
                  animationDelay: `${d.delay}s`,
                  ['--clawd-y0' as string]: `${Math.round(d.fy * h)}px`,
                  ['--clawd-fall' as string]: `${h + 4}px`,
                }}
              />
            ))}

            {/* Snow falls slowly and sways, and settles in a thin strip on the ground */}
            {weather.kind === 'snow' && (
              <g className="text-slate-400 dark:text-zinc-200">
                {FLAKES.slice(0, Math.min(FLAKES.length, fall)).map((f, i) => (
                  <g
                    key={i}
                    className="clawd-flake"
                    style={{
                      animationDuration: `${f.dur}s`,
                      animationDelay: `${f.delay}s`,
                      ['--clawd-y0' as string]: `${Math.round(f.fy * h)}px`,
                      ['--clawd-fall' as string]: `${h + 2}px`,
                    }}
                  >
                    <rect
                      x={Math.round(f.fx * w)} y={0} width={1.6} height={1.6}
                      fill="currentColor" opacity={0.75}
                      className="clawd-flake-sway"
                      style={{ animationDuration: `${f.sway}s`, animationDelay: `${f.delay}s` }}
                    />
                  </g>
                ))}
                <rect x={0} y={h - 1.5} width={w} height={1.5} fill="currentColor"
                      opacity={0.3 + 0.2 * look.light} />
              </g>
            )}

            {/* A thunderstorm flashes now and then, sometimes twice in a row */}
            {weather.storm && (
              <rect x="0" y="0" width={w} height={h} fill="currentColor"
                    className="clawd-flash text-slate-500 dark:text-slate-50" />
            )}
          </g>
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
}

/** The ground Clawd walks on, beside the percentage */
export function ClawdScene({ render, onSpan, onPointer, onPet }: ClawdSceneProps) {
  const [ref, w] = useWidth();

  useEffect(() => { onSpan(w); }, [w, onSpan]);

  const handleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (box) onPointer(e.clientX - box.left);
  }, [onPointer, ref]);

  const handleLeave = useCallback(() => onPointer(null), [onPointer]);

  const bubbleColor = render?.bubbleKind === 'ask' ? '#FBBF24'
    : render?.bubbleKind === 'cheer' ? '#4ADE80'
    : '#93C5FD';

  // The mascot box sits on the ground, minus the empty lower half-row, plus however far he has
  // jumped; everything else is placed from the bottom edge of the scene the same way.
  const mascotTop = render ? SCENE_H - MASCOT_H + MASCOT_SINK - render.lift : 0;
  const fromBottom = (y: number) => SCENE_H - y;

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
            <Pixels rects={render.geo.body} fill={CLAWD_BODY} />
            <Pixels rects={render.geo.eyes} fill={CLAWD_EYE} />
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

          {/* "?" when something waits for you, "!" when the window resets */}
          {render.bubble && (
            <text
              x={render.x + 18} y={fromBottom(render.bubbleY)}
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
