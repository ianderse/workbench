/**
 * The scene Clawd lives in: a drifting pixel sky across the whole row, with the crab walking
 * along the ground beside the percentage.
 *
 * Everything is drawn as whole pixels, in the same units as the sprite (see ./clawd/sprite.ts),
 * so it stays crisp at any UI scale.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HEART_FULL } from './clawd/heart';
import {
  CLAWD_BODY, CLAWD_EYE, CLAWD_FX, CLAWD_SAND, MASCOT_H, MASCOT_SINK,
  type Rect,
} from './clawd/sprite';
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

/** One cloud: its shape, how high it floats and how long it takes to cross */
const CLOUDS = [
  { shape: 0, top: 0.08, dur: 71, delay: -12 },
  { shape: 1, top: 0.30, dur: 53, delay: -37 },
  { shape: 2, top: 0.14, dur: 88, delay: -60 },
  { shape: 1, top: 0.02, dur: 64, delay: -24 },
  { shape: 0, top: 0.34, dur: 97, delay: -75 },
];

function cloudRects(rows: string[]): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y < rows.length; y++) {
    let x = 0;
    while (x < rows[y].length) {
      if (rows[y][x] !== '#') { x++; continue; }
      const x0 = x;
      while (x < rows[y].length && rows[y][x] === '#') x++;
      out.push({ x: x0 * CLOUD_PX, y: y * CLOUD_PX, w: (x - x0) * CLOUD_PX, h: CLOUD_PX });
    }
  }
  return out;
}
const CLOUD_RECTS = CLOUD_SHAPES.map(cloudRects);
const CLOUD_W = CLOUD_SHAPES.map((rows) => rows[0].length * CLOUD_PX);

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
 * The sky, drawn across the whole row behind both the percentage and the mascot, fading out at
 * either edge so the clouds drift in and out of nothing.
 */
export function ClawdSky() {
  const [ref, w] = useWidth();
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 text-muted-foreground">
      {w > 0 && (
        <svg
          width={w}
          height={SCENE_H}
          viewBox={`0 0 ${w} ${SCENE_H}`}
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
            {/* The light the sky is lit by, strongest low and in the middle */}
            <radialGradient id="clawd-sky-glow" cx="0.5" cy="0.68" r="0.75">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.17" />
              <stop offset="0.5" stopColor="currentColor" stopOpacity="0.08" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </radialGradient>
            <mask id="clawd-sky-mask">
              <rect x="0" y="0" width={w} height={SCENE_H} fill="url(#clawd-sky-fade)" />
            </mask>
          </defs>
          <g mask="url(#clawd-sky-mask)">
            <rect x="0" y="0" width={w} height={SCENE_H} fill="url(#clawd-sky-glow)" />
            {CLOUDS.map((c, i) => (
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
                <g transform={`translate(0 ${Math.round(c.top * SCENE_H)})`}>
                  <Pixels rects={CLOUD_RECTS[c.shape]} fill="currentColor" opacity={0.28} />
                </g>
              </g>
            ))}
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
