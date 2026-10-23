/**
 * The nodes are jelly. Their borders are rounded and bow in slow lobes, a new
 * node squeezes out of its parent, and a finished one is drawn back in until it
 * merges — the same move either way, run backwards or forwards by the node's
 * own fade. While the two are close they are gooed
 * together: each border stretches out toward the other into a neck that thins
 * as the node travels, and the overlap is clipped away (see node-motion.ts), so
 * the two read as one shape that pinches off. The shapes themselves are kept —
 * the main agent's pentagon, a sub-agent's hexagon, a background session's
 * square, a tool's circle — only rounded, bowed and squashed along the way.
 */

export const JELLY = {
  /** Corner radius, of the node's own radius (the shape keeps its circumradius) */
  corner: 0.3,
  /** The border's resting wobble: `k` lobes per turn, `amp` of the radius, drifting at `speed` rad/s */
  lobes: [
    { k: 2, amp: 0.026, speed: 0.55 },
    { k: 3, amp: 0.016, speed: -0.8 },
    { k: 5, amp: 0.008, speed: 1.1 },
  ],
  /** Outline samples along each corner's arc and each edge between them (a
   *  circle is sampled `circleSamples`); a node drawn into a neck is sampled
   *  finer, so the neck itself comes out smooth */
  cornerSamples: 7,
  edgeSamples: 7,
  circleSamples: 48,
  gooCornerSamples: 13,
  gooEdgeSamples: 13,
  gooCircleSamples: 112,
  /**
   * Coming out of the parent and going back into it: one move, run either way
   * by how far the node has faded in. Fully faded it sits merged on the
   * parent's border; fully opaque it sits in its own place. Since a node fades
   * in and out at the same rate (see ANIM_SPEED), budding off takes exactly as
   * long as merging back and is its mirror image.
   */
  merge: {
    /** Eases the way: slow by the parent's border, where the goo stretches, and quick out at the node's own place */
    ease: 2,
    /** Where on the parent's border it sits merged, of the way to its center */
    rimAt: 1,
    /** Its size there, relative to its own */
    rimScale: 0.3,
    /** How far it is drawn out along the way there while it is merged */
    rimStretch: 0.45,
  },
  /** The neck of goo between a node and the parent it is coming out of or going back into */
  goo: {
    /** The gap between the two borders (world units) at which the neck snaps */
    reach: 34,
    /** Each side stretches this much past the halfway point, so the two meet and overlap */
    margin: 4,
    /** How tightly the neck is drawn in: it is a broad bulge up close and a thread as it stretches */
    focusNear: 3,
    focusFar: 11,
    /** However far the gap, a border is never drawn out further than this many radii */
    maxLength: 4,
  },
  /** The parent's own reaction where a node buds off it or merges back into it */
  poke: {
    /** Outward, as a node is pushed out; inward, as one is taken back in */
    birth: 0.18,
    arrival: -0.26,
    duration: 0.9,
    decay: 4.5,
    freq: 13,
    /** However many dents land together, the border never moves further than this */
    limit: 0.28,
  },
} as const

/** A dent the node is still ringing from, on the side `dir` points to */
export interface JellyPoke {
  dirX: number
  dirY: number
  /** How hard, and which way: positive bulges the border outward, negative dents it in */
  strength: number
  age: number
}

/** The node's border drawn out toward another it is gooed to */
export interface JellyReach {
  dirX: number
  dirY: number
  /** How far out, in node radii */
  length: number
  /** The higher, the tighter the neck is drawn in around `dir` */
  focus: number
}

/** Where and how a node is drawn this frame: its slot once it has settled, and
 *  on its way out of or back into its parent while it hasn't */
export interface NodeMotion {
  x: number
  y: number
  /** The node's own radius, before `scale` */
  radius: number
  /** Size multiplier: its breathing, and growing in or shrinking as it merges */
  scale: number
  /** Corners of its shape: 5 the main agent, 6 a sub-agent, 4 a background session, 0 a tool circle */
  sides: number
  rotation: number
  /** Squash and stretch: >0 stretches along (axisX, axisY) and squashes across it */
  stretch: number
  axisX: number
  axisY: number
  /** Phase offset, so no two nodes wobble alike */
  seed: number
  pokes: readonly JellyPoke[]
  reaches: readonly JellyReach[]
  /** The nodes it is gooed to: their shapes are clipped out of it (see clipOutsideAttached) */
  attached: readonly string[]
}

const NO_POKES: readonly JellyPoke[] = []
const NO_REACHES: readonly JellyReach[] = []
const NOT_ATTACHED: readonly string[] = []

/** A node that sits still: its border wobbles, nothing else moves */
export function restingMotion(x: number, y: number, radius = 0, sides = 0, rotation = 0): NodeMotion {
  return {
    x, y, radius, scale: 1, sides, rotation,
    stretch: 0, axisX: 0, axisY: 1, seed: 0,
    pokes: NO_POKES, reaches: NO_REACHES, attached: NOT_ATTACHED,
  }
}

/** A damped spring's ring: 1 at p = 0, swinging through 0 as it fades out */
function springRing(p: number, decay: number, freq: number): number {
  return p >= 1 ? 0 : Math.exp(-decay * p) * Math.cos(freq * p)
}

/** Phase offset for a node, from its id */
export function jellySeed(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  return (Math.abs(hash) % 1000) / 1000 * Math.PI * 2
}

/** How far a shape's border is from its center where it is nearest: at a flat's
 *  middle for a polygon (its rounded corners bring that in less), the radius for a circle */
export function shapeInradius(radius: number, sides: number): number {
  if (sides < 3) return radius
  return radius * ((1 - JELLY.corner) * Math.cos(Math.PI / sides) + JELLY.corner)
}

function lobeDeform(u: number, seed: number, time: number): number {
  let d = 0
  for (const lobe of JELLY.lobes) {
    d += lobe.amp * Math.sin(Math.PI * 2 * lobe.k * u + seed * lobe.k + lobe.speed * time)
  }
  return d
}

/** A dent is deepest straight along its direction and runs out to nothing
 *  sideways. Dents that land together add up, up to `JELLY.poke.limit`. */
function pokeDeform(nx: number, ny: number, pokes: readonly JellyPoke[]): number {
  let d = 0
  for (const poke of pokes) {
    const facing = nx * poke.dirX + ny * poke.dirY
    if (facing <= 0) continue
    d += poke.strength * facing * facing
      * springRing(poke.age / JELLY.poke.duration, JELLY.poke.decay, JELLY.poke.freq)
  }
  const limit = JELLY.poke.limit
  return d > limit ? limit : d < -limit ? -limit : d
}

/** The border drawn out toward what the node is gooed to: furthest straight
 *  along the way there, tapering off to the sides the tighter `focus` is */
function reachDeform(nx: number, ny: number, reaches: readonly JellyReach[]): number {
  let d = 0
  for (const reach of reaches) {
    const facing = nx * reach.dirX + ny * reach.dirY
    if (facing <= 0) continue
    d += reach.length * Math.pow(facing, reach.focus)
  }
  return d
}

function deformAt(u: number, nx: number, ny: number, motion: NodeMotion, time: number): number {
  let d = lobeDeform(u, motion.seed, time)
  if (motion.pokes.length > 0) d += pokeDeform(nx, ny, motion.pokes)
  if (motion.reaches.length > 0) d += reachDeform(nx, ny, motion.reaches)
  return d
}

/**
 * Path a node's border: the regular polygon with `sides` corners (one at the
 * top, turned by `rotation`) with its corners rounded, or a circle for `sides`
 * under 3 — deformed, and squashed and stretched, as the jelly has it. Every
 * path a node is drawn with goes through this, so its glow, scanline, border
 * and the shapes clipped out of it all agree.
 */
export function drawJellyShape(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number,
  sides: number, rotation: number,
  motion: NodeMotion, time: number,
) {
  const gooing = motion.reaches.length > 0
  const circle = sides < 3
  const arcSamples = gooing ? JELLY.gooCornerSamples : JELLY.cornerSamples
  const edgeSamples = gooing ? JELLY.gooEdgeSamples : JELLY.edgeSamples
  const count = circle
    ? (gooing ? JELLY.gooCircleSamples : JELLY.circleSamples)
    : sides * (arcSamples + edgeSamples)

  const stretch = Math.abs(motion.stretch) < 0.002 ? 0 : motion.stretch
  const ax = motion.axisX, ay = motion.axisY
  let index = 0

  /** One sample, at the offset (ox, oy) from the node's center */
  const emit = (ox: number, oy: number) => {
    const len = Math.hypot(ox, oy) || 1
    const grown = 1 + deformAt(index / count, ox / len, oy / len, motion, time)
    let dx = ox * grown
    let dy = oy * grown
    if (stretch !== 0) {
      // Volume stays: as far as it is stretched along the axis, it is squashed across it
      const along = (dx * ax + dy * ay) * (1 + stretch)
      const across = (dy * ax - dx * ay) / (1 + stretch)
      dx = along * ax - across * ay
      dy = along * ay + across * ax
    }
    const px = cx + dx, py = cy + dy
    if (index === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
    index++
  }

  ctx.beginPath()
  if (circle) {
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count - Math.PI / 2 + rotation
      emit(Math.cos(angle) * radius, Math.sin(angle) * radius)
    }
  } else {
    // A rounded polygon: corners of radius `cornerR` centered on the corners of
    // a polygon that much smaller, joined by the flats between them
    const cornerR = radius * JELLY.corner
    const cornerDist = radius - cornerR
    const cone = Math.PI / sides
    for (let k = 0; k < sides; k++) {
      const at = cone * 2 * k - Math.PI / 2 + rotation
      const kx = Math.cos(at) * cornerDist, ky = Math.sin(at) * cornerDist
      for (let s = 0; s < arcSamples; s++) {
        const angle = at - cone + (cone * 2 * s) / (arcSamples - 1)
        emit(kx + Math.cos(angle) * cornerR, ky + Math.sin(angle) * cornerR)
      }
      // The flat to the next corner, from this arc's end to that arc's start
      const faceX = Math.cos(at + cone) * cornerR, faceY = Math.sin(at + cone) * cornerR
      const nextAt = at + cone * 2
      const nx = Math.cos(nextAt) * cornerDist, ny = Math.sin(nextAt) * cornerDist
      for (let s = 1; s <= edgeSamples; s++) {
        const f = s / (edgeSamples + 1)
        emit(kx + faceX + (nx - kx) * f, ky + faceY + (ny - ky) * f)
      }
    }
  }
  ctx.closePath()
}

/** The node's border, where the jelly has it */
export function pathNodeShape(ctx: CanvasRenderingContext2D, motion: NodeMotion, time: number) {
  drawJellyShape(ctx, motion.x, motion.y, motion.radius * motion.scale, motion.sides, motion.rotation, motion, time)
}

/** Squash and stretch what a node holds (its glow, its icon, its face) the way
 *  its border is squashed and stretched */
export function applyJellyStretch(ctx: CanvasRenderingContext2D, motion: NodeMotion) {
  if (Math.abs(motion.stretch) < 0.002) return
  const angle = Math.atan2(motion.axisY, motion.axisX)
  ctx.translate(motion.x, motion.y)
  ctx.rotate(angle)
  ctx.scale(1 + motion.stretch, 1 / (1 + motion.stretch))
  ctx.rotate(-angle)
  ctx.translate(-motion.x, -motion.y)
}
