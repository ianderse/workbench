import { BEAM } from './agent-types'

// ─── Visibility threshold ───────────────────────────────────────────────────

/** Minimum opacity for an element to be considered visible (edges to fainter nodes aren't drawn) */
export const MIN_VISIBLE_OPACITY = 0.05

// ─── Node placement ─────────────────────────────────────────────────────────

/**
 * How far a node sits from its parent: close enough that the edge between them
 * comes out exactly as long as the parent node is wide, and no longer. An edge
 * runs from border to border with `BEAM.nodeGap` clear of each, so the distance
 * is the parent's width plus what the two nodes take up.
 */
export function nodeDistance(parentRadius: number, nodeRadius: number): number {
  return parentRadius * 2 + parentRadius + nodeRadius + BEAM.nodeGap * 2
}

// ─── Mock scenario buffer ──────────────────────────────────────────────────

export const MOCK_END_BUFFER_S = 8

// ─── Animation speeds and frame timing ───────────────────────────────────────
// The rates are per second (multiplied by deltaTime); the rest cap, default or
// gate the frame time

/**
 * Seconds a node takes to come out of its parent, and to merge back into it.
 * Its fade is what carries it (see JELLY.merge), so every node fades in and out
 * over this same stretch and the two moves are each other's mirror.
 */
export const MERGE_S = 0.56

export const ANIM_SPEED = {
  /** Agent fade-in, as it comes out of its parent (opacity per dt) */
  agentFadeIn: 1 / MERGE_S,
  /** Agent fade-out after complete, as it merges back into its parent (opacity per dt) */
  agentFadeOut: 1 / MERGE_S,
  /** Tool fade-in, as it comes out of its agent (opacity per dt) */
  toolFadeIn: 1 / MERGE_S,
  /** Tool fade-out after it has finished, as it merges back into its agent (opacity per dt) */
  toolFadeOut: 1 / MERGE_S,
  /** Default delta time cap (seconds) */
  maxDeltaTime: 0.1,
  /** Default delta time when time info unavailable */
  defaultDeltaTime: 0.016,
  /** Minimum ms between frames (60fps cap, with 1ms slack for timing jitter) */
  minFrameInterval: (1000 / 60) - 1,
} as const

/** Seconds a finished tool or sub-agent stays fully visible, its edge flowing
 *  back to the caller with the answer, before the node fades out */
export const ANSWER_HOLD_S = 1.2

/** Seconds a tool node stays on screen at least, from when it appeared: calls
 *  such as Read, Edit or Write finish within milliseconds and would otherwise
 *  only flash by */
export const TOOL_MIN_VISIBLE_S = 3

// ─── Camera constants ───────────────────────────────────────────────────────

export const CAMERA = {
  /** Resting zoom: used whenever the whole graph fits on the page; auto-fit
   *  only zooms out from here (never further in) when nodes would overflow */
  restScale: 3,
  /** Screen pixels kept free between the graph and the page edge */
  viewMargin: 40,
  /** Furthest auto-fit will zoom out */
  minZoom: 0.2,
} as const

// ─── Tool slot placement config ─────────────────────────────────────────────

export const NODE_SLOT = {
  /** Rings tried outward from the parent; if every slot is taken, the least crowded one is used */
  maxRings: 12,
  /** How much further out each ring past the first sits */
  ringIncrement: 25,
  /** Angles tried per ring: about one per node width, within these bounds */
  minSteps: 16,
  maxSteps: 96,
  /** Minimum space between a node and another tool or agent */
  gap: 12,
} as const

// ─── Agent drawing constants ────────────────────────────────────────────────

export const AGENT_DRAW = {
  /** Outer glow extra radius beyond agent radius */
  glowPadding: 20,
  /** Ambient outer ring offset from agent radius */
  outerRingOffset: 3,
  /** Scanline gradient half-height */
  scanlineHalfH: 4,
  /** Scanline width = 2 * scanlineHalfH */
  scanlineWidth: 8,
  /** Dash offset animation speed for waiting state */
  waitingDashSpeed: 25,
  /** Active-state pulse (thinking / waiting for permission): the node's own glow
   *  brightens and dims, down to `glowPulseTrough` of its full brightness */
  glowPulseSpeed: 2.4,
  glowPulseTrough: 0.4,
  /** Waiting state breathe parameters */
  waitingBreatheSpeed: 1.2,
  waitingBreatheAmp: 0.08,
  /** Claude spark logo scale: the radius times this spans `sparkViewBox` path units */
  sparkScale: 0.45,
  /** Centre of the Claude spark path (half its 512-unit viewBox), where it's drawn from */
  sparkViewBox: 256,
  /** Sub-agent icon (the Agents menu icon) width relative to radius */
  subIconScale: 0.9,
} as const

// ─── Main agent face ────────────────────────────────────────────────────────
// Sizes and offsets are in node radii

export const FACE = {
  /** Eye width; its height is this times eyeAspect */
  eyeWidth: 0.36,
  eyeAspect: 1.15,
  /** Each eye's center from the node's (the pentagon's middle sits a bit below its center) */
  eyeOffsetX: 0.28,
  eyeOffsetY: 0.08,
  /** How far the eyes move when looking aside, and how much bigger the nearer eye gets */
  gazeShiftX: 0.14,
  gazeShiftY: 0.1,
  gazePerspective: 0.08,
  /** Easing rates (per second): the pose between expressions, an expression's motion */
  poseEase: 10,
  motionEase: 5,
  /** Seconds between blinks (at least blinkMinGap, plus up to blinkJitter) */
  blinkMinGap: 2.4,
  blinkJitter: 3,
  blinkDuration: 0.16,
  doubleBlinkGap: 0.24,
  doubleBlinkChance: 0.25,
  /** Seconds the face laughs after a turn ends, before it has nothing to do */
  happyDuration: 2.2,
  /** The resting cycle, with nothing to do: it looks about for lookDuration,
   *  sulks for the rest of boredDuration, then whistles for as long again,
   *  and around it goes (all in seconds) */
  lookDuration: 5,
  boredDuration: 30,
  /** How long the bored lids take to sink before it catches itself (seconds) */
  sagCycle: 7,
  /** How far aside the bored gaze parks, and how far down it sits: it holds
   *  there, looking for something interesting, and only moves on over a blink */
  boredLookX: 0.85,
  boredGazeY: 0.06,
  /** The bored eye: wider and shorter, and (at boredShape 1) the lid flat
   *  across the top with the eye rounded off underneath. How fast it takes
   *  that shape, per second. */
  boredShapeSpeed: 5,
  /** The eyes closing into happy arcs as it whistles, and snapping back open
   *  when it is caught at it (per second) */
  squintSpeed: 6,
  squintOpenSpeed: 16,
  /** Caught whistling: the eyes snap open over startleOpen, stay open while
   *  it takes in who wants it now, and only then does it get on with the work
   *  (seconds) */
  startleOpen: 0.26,
  startleDuration: 0.62,
  /** Closed happy eyes: an upward arc, as wide as an eye and bowed this far up,
   *  stroked this thick */
  arcWidth: 0.34,
  arcLift: 0.11,
  arcWeight: 0.07,
  /** Which side it whistles its first blow out of (-1 left): the side the
   *  mouth puckers to, with the eye above it squeezed narrower. It swaps over
   *  on every breath, so the mouth works its way from one corner to the other
   *  and back (see FaceState.whistleSide) */
  whistleSide: -1,
  /** The pucker it whistles through: it is there for a whole blow (the eyes
   *  are shut with it), puckering up `blowLead` seconds before the blow's
   *  first note (eased in at blowEase, per second) and going the instant its
   *  last one is out, and opening a touch as each note comes out of it
   *  (blowRise and blowFall, in seconds) */
  mouthX: 0.21,
  mouthY: 0.4,
  mouthRadius: 0.08,
  blowLead: 0.2,
  blowEase: 9,
  blowRise: 0.08,
  blowFall: 0.22,
  /** How fast the whistling head bobs along, and how far */
  whistleBobSpeed: 4.4,
  whistleBobAmp: 0.028,
  /** Eye glow blur (pixels) */
  glowBlur: 8,
} as const

// ─── Whistled notes ─────────────────────────────────────────────────────────
// The sheet music the bored main agent whistles (see canvas/draw-notes.ts).
// Notes come in short phrases, none of them the same, so the tune never repeats

export const WHISTLE = {
  /** Notes in one blow: never fewer than phraseMin, up to phraseMin +
   *  phraseRange (the pucker holds until the blow's last note is out) */
  phraseMin: 3,
  phraseRange: 4,
  /** Seconds between two notes of a blow, and between blows (plus jitter) */
  noteGap: 0.26,
  noteGapJitter: 0.22,
  phraseGap: 0.9,
  phraseGapJitter: 1.5,
  /** Notes in the air at once (the oldest gives way) */
  maxNotes: 14,
  /** Half a note's height, in node radii */
  size: 0.13,
  sizeJitter: 0.06,
  /** How far along the mouth a note can come out (node radii) */
  mouthSpread: 0.12,
  /** How fast it floats away and drifts aside (world units per second) */
  riseSpeed: 24,
  riseJitter: 14,
  driftSpeed: 16,
  driftJitter: 20,
  /** Its sideways swing on the way up (world units) and how fast it swings */
  sway: 2.5,
  swayJitter: 3,
  swaySpeed: 2.2,
  /** Where it starts tilted (radians) and how fast it turns on the way */
  tilt: 0.3,
  spin: 0.5,
  /** Seconds it stays in the air, and the fades at either end */
  life: 1.9,
  lifeJitter: 0.9,
  fadeIn: 0.18,
  fadeOut: 0.7,
  alpha: 0.9,
  /** Note glow blur (pixels) */
  glowBlur: 6,
} as const

// ─── Tool node drawing constants ────────────────────────────────────────────

export const TOOL_DRAW = {
  /** Tool name font size */
  fontSize: 8,
  /** Space between the text and the circle edge */
  padding: 5,
  minRadius: 14,
  /** Error glow base blur + pulse amplitude */
  errorGlowBase: 8,
  errorGlowPulse: 4,
  /** Running-state ripples: 2 staggered rings expanding from the circle edge
   *  and fading out (like a busy agent's hexagon rings) */
  rippleInnerOffset: 3,
  rippleMaxExpand: 22,
  rippleMaxAlpha: 0.45,
  rippleSpeed: 0.65,
} as const

/** Radius of a tool circle that fully contains its name, given its width */
function toolNodeRadius(nameWidth: number): number {
  return Math.max(TOOL_DRAW.minRadius, Math.ceil(Math.hypot(nameWidth / 2, TOOL_DRAW.fontSize / 2)) + TOOL_DRAW.padding)
}

/** Monospace glyphs are ~0.6em wide: the tool circles are sized from that
 *  rather than measured, so their layout, their edges and the shapes clipped
 *  out of them (see lib/jelly.ts) all agree. */
const MONO_CHAR_W = 0.6

/** A tool circle's radius, from its name alone. */
export function estimateToolNodeRadius(toolName: string): number {
  return toolNodeRadius(toolName.length * TOOL_DRAW.fontSize * MONO_CHAR_W)
}

// ─── Effect drawing constants ───────────────────────────────────────────────

export const SPAWN_FX = {
  ringStart: 10,
  ringExpand: 60,
  maxAlpha: 0.7,
  flashThreshold: 0.3,
  flashAlpha: 0.6,
  flashBaseRadius: 20,
  flashMinRadius: 5,
  particleCount: 8,
  particleSize: 1.5,
} as const
