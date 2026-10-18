import type { Agent, AgentState, ToolCallNode } from '../../lib/agent-types'
import { FACE, WHISTLE } from '../../lib/canvas-constants'
import { advanceNotes, spawnNote, type WhistleNote } from './draw-notes'

/**
 * The main agent's face: two eyes (the shape of agent-flow's EMO sample: a
 * rounded rectangle 1.15 times as tall as wide, top corners 38%, bottom 45%)
 * that show how the agent is doing. Only how the eyes move changes with the
 * agent's state; their shape and color (the node's) don't.
 *
 * Left with nothing to do it looks about for a few seconds and then sulks
 * with heavy lids until FACE.boredDuration is up; then it whistles to
 * itself for as long again — one blow at a time, eyes shut happy over it and
 * notes drifting out of its pucker (see draw-notes.ts), eyes open again for
 * the breath between two blows — and the two take turns for as long as it is
 * left alone. Caught at it by new work, its eyes snap open for a moment
 * before it takes up what it has to do.
 */

/** What the face shows */
type Expression =
  | 'ponder'   // thinking: gaze drifts up and around
  | 'focus'    // calling a tool: narrowed, looking at the tool
  | 'ask'      // waiting for permission: wide puppy eyes toward the terminal
  | 'upset'    // a tool failed: frowning, a shake
  | 'watch'    // waiting on sub-agents: following the newest one
  | 'happy'    // just finished its turn: a short laugh
  | 'awkward'  // nothing to do: uneven eyes looking around, sneaking glances back
  | 'bored'    // bored: flat lids over round eyes, sinking, still looking about
  | 'whistle'  // bored long enough: eyes closed happy, notes out of its mouth
  | 'startled' // caught whistling: eyes snapped open, taking it in

/** One eye, in node radii from the node's center (x, y), scaled (sx, sy) and tilted (radians) */
interface EyePose { x: number; y: number; sx: number; sy: number; tilt: number }
interface FacePose { left: EyePose; right: EyePose }

/** A face's animation state, kept between frames (per canvas, see AgentCanvas) */
export interface FaceState {
  pose: FacePose
  /** Strength of the expression's own motion (shake, laugh, bob), eased in and out */
  motion: number
  /** 0 eyes open, 1 closed into the happy arcs it whistles with */
  squint: number
  /** 0 the eye's own shape, 1 the bored one: lid flat over a round eye */
  boredShape: number
  expression: Expression
  /** When the expression started (graph clock seconds) */
  since: number
  lastTime: number
  /** The happy laugh after a turn lasts until this time */
  happyUntil: number
  /** When the agent last had nothing left to do, 0 while it works: the clock
   *  the boredom and the whistling run on */
  idleSince: number
  /** A startle runs until this time, whatever the agent has started doing */
  startleUntil: number
  nextBlink: number
  blinkStart: number
  doubleBlink: boolean
  /** A quick glance away (focus), and when the next one comes */
  saccade: { x: number; y: number }
  nextSaccade: number
  /** Where the bored gaze is parked (an index into BORED_LOOKS), and when the
   *  blink it moves over has the eyes shut enough to move it (0: not due) */
  boredLook: number
  boredSwitchAt: number
  /** The notes it has whistled into the air, when the last one came out (the
   *  pucker opens with it), when the next one is due, and how many are left in
   *  the blow it is on */
  notes: WhistleNote[]
  lastNote: number
  nextNote: number
  phraseLeft: number
  /** Whether it is blowing right now: in between it takes a breath, with the
   *  pucker gone and the eyes open again. `blow` is that, eased, for the pucker. */
  blowing: boolean
  blow: number
  /** The side it is whistling out of (-1 left): it swaps over on every breath,
   *  so the pucker, the notes and the puffed-up eye above it change sides */
  whistleSide: -1 | 1
}

const WORKING: ReadonlySet<AgentState> = new Set(['thinking', 'tool_calling', 'waiting_permission', 'error'])

/** The expressions of an agent at work: coming out of one into an idle moment
 *  is what the happy laugh follows */
const AT_WORK: ReadonlySet<Expression> = new Set(['ponder', 'focus', 'ask', 'upset', 'watch', 'startled'])

const restingEye = (side: -1 | 1): EyePose => ({ x: side * FACE.eyeOffsetX, y: FACE.eyeOffsetY, sx: 1, sy: 1, tilt: 0 })

/** Where the bored gaze parks itself, in turn: off to one side, off to the
 *  other, then straight ahead — and round again */
const BORED_LOOKS = [-FACE.boredLookX, FACE.boredLookX, 0]

function newFace(time: number): FaceState {
  return {
    pose: { left: restingEye(-1), right: restingEye(1) },
    motion: 0,
    squint: 0,
    boredShape: 0,
    expression: 'bored',
    since: time,
    lastTime: time,
    happyUntil: 0,
    idleSince: 0,
    startleUntil: 0,
    nextBlink: time + FACE.blinkMinGap + Math.random() * FACE.blinkJitter,
    blinkStart: -Infinity,
    doubleBlink: false,
    saccade: { x: 0, y: 0 },
    nextSaccade: time,
    boredLook: 0,
    boredSwitchAt: 0,
    notes: [],
    lastNote: -Infinity,
    nextNote: time,
    phraseLeft: 0,
    blowing: false,
    blow: 0,
    whistleSide: FACE.whistleSide,
  }
}

/** Unit vector from the agent toward a point, or none if it's on top of it */
function toward(agent: Agent, x: number, y: number): { x: number; y: number } | null {
  const dx = x - agent.x, dy = y - agent.y
  const d = Math.hypot(dx, dy)
  return d < 1 ? null : { x: dx / d, y: dy / d }
}

const smooth = (p: number) => p * p * (3 - 2 * p)

/** The bored lids sinking, then the small jolt that pulls them back up */
function boredSag(t: number): number {
  const c = (t % FACE.sagCycle) / FACE.sagCycle
  return c < 0.8 ? c / 0.8 : Math.max(0, 1 - (c - 0.8) / 0.08)
}

/** Where the face looks for an expression (-1..1 each way; +y is down) */
function gazeFor(face: FaceState, agent: Agent, agents: Map<string, Agent>, toolCalls: Map<string, ToolCallNode>, time: number) {
  const t = time - face.since
  switch (face.expression) {
    case 'ponder':
      // Up and around, as if looking for the answer
      return { x: Math.sin(t * 0.55) * 0.75, y: -0.55 + Math.sin(t * 0.9) * 0.2 }
    case 'focus': {
      // At its newest running tool, with small quick glances around it
      let newest: ToolCallNode | undefined
      for (const tc of toolCalls.values()) {
        if (tc.agentId === agent.id && tc.state === 'running' && (!newest || tc.startTime > newest.startTime)) newest = tc
      }
      const dir = newest ? toward(agent, newest.x, newest.y) : null
      return { x: (dir?.x ?? 0) * 0.85 + face.saccade.x, y: (dir?.y ?? 0.1) * 0.85 + face.saccade.y }
    }
    case 'ask':
      // Toward the terminal (left of the graph), where the permission prompt is
      return { x: -0.6, y: 0.3 }
    case 'watch': {
      // The newest sub-agent still working
      let child: Agent | undefined
      for (const other of agents.values()) {
        if (other.parentId === agent.id && other.state !== 'complete') child = other
      }
      const dir = child ? toward(agent, child.x, child.y) : null
      return { x: (dir?.x ?? 0) * 0.8 + Math.sin(t * 0.7) * 0.08, y: (dir?.y ?? 0) * 0.8 }
    }
    case 'upset':
      return { x: 0, y: 0.15 }
    case 'awkward': {
      // Looking away and down, with a quick glance back now and then (and away again)
      const cycle = t % 3.4
      const glance = cycle > 2.6 && cycle < 3.05
      return glance ? { x: 0.15, y: 0 } : { x: -0.75, y: 0.4 }
    }
    case 'bored':
      // Off to one side, waiting for something interesting to turn up there.
      // It holds that way until the next blink takes it to the next station
      // (see drawFace): the eyes never sweep, they are just somewhere else
      // when they open again.
      return { x: BORED_LOOKS[face.boredLook], y: FACE.boredGazeY }
    case 'whistle':
      // Over a blow the eyes are shut and only the arcs sway with the tune;
      // between two of them they are open, and look up at nothing in particular
      return face.blowing
        ? { x: Math.sin(t * 0.6) * 0.08, y: -0.04 }
        : { x: Math.sin(t * 0.5) * 0.3, y: -0.3 }
    case 'startled':
      // Caught: up and straight ahead, taking in who wants it now
      return { x: 0, y: -0.12 }
    default:
      return { x: 0, y: 0 }
  }
}

/** The pose an expression holds (before blinks and its own motion), `t` seconds in */
function targetPose(face: FaceState, gaze: { x: number; y: number }, t: number): FacePose {
  const eye = (side: -1 | 1): EyePose => {
    const pose = restingEye(side)
    switch (face.expression) {
      case 'ponder':
        // The eye on the side it looks to opens a little wider (a curious glance)
        pose.sy = 1 + side * gaze.x * 0.06
        break
      case 'focus':
        pose.sx = 1.08
        pose.sy = 0.66
        pose.tilt = side * -0.1 // inner corners down: determined
        break
      case 'ask':
        pose.sx = 1.12
        pose.sy = 1.12
        pose.tilt = side * 0.16 // outer corners down: pleading
        break
      case 'upset':
        pose.sy = 0.62
        pose.y += 0.04
        pose.tilt = side * -0.32 // a frown
        break
      case 'happy':
        pose.sx = 1.1
        pose.sy = 0.5
        pose.y -= 0.07
        pose.tilt = side * 0.13
        break
      case 'awkward':
        // Uneven: one eye squeezed and tilted, the other a bit higher
        if (side === -1) {
          pose.sy = 0.8
          pose.tilt = 0.14
          pose.y += 0.02
        } else {
          pose.tilt = -0.06
          pose.y -= 0.03
        }
        break
      case 'bored': {
        // Wide and short under a flat lid (the shape itself is drawn from
        // FaceState.boredShape), sinking lower until it catches itself
        const sag = boredSag(t)
        pose.sx = 1.22
        pose.sy = 0.64 - 0.14 * sag
        pose.y += 0.05 + 0.04 * sag
        pose.tilt = side * 0.08 // outer corners down: unimpressed
        break
      }
      case 'whistle':
        if (face.blowing) {
          // Shut (the happy arcs are drawn instead, see drawFace); the puffed
          // cheek pushes the eye above it up and tips it further
          pose.sy = 0.12
          pose.y -= side === face.whistleSide ? 0.08 : 0.04
          pose.tilt = side * (side === face.whistleSide ? 0.18 : 0.1)
        } else {
          // Between two blows: open again, but relaxed and pleased with
          // itself — wider than it is tall, not the full working stare
          pose.sx = 1.12
          pose.sy = 0.62
          pose.y -= 0.02
          pose.tilt = side * 0.08
        }
        break
      case 'startled': {
        // Snapped wide open, then held open while it comes to
        const wide = t < FACE.startleOpen ? 1 : 0
        pose.sx = 1 + 0.2 * wide
        pose.sy = 1.06 + 0.28 * wide
        break
      }
    }
    // Looking aside moves both eyes that way; the nearer eye looks a bit bigger
    pose.x += gaze.x * FACE.gazeShiftX
    pose.y += gaze.y * FACE.gazeShiftY
    const near = 1 + side * gaze.x * FACE.gazePerspective
    pose.sx *= near
    pose.sy *= near
    return pose
  }
  return { left: eye(-1), right: eye(1) }
}

function lerpPose(from: EyePose, to: EyePose, k: number): EyePose {
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    sx: from.sx + (to.sx - from.sx) * k,
    sy: from.sy + (to.sy - from.sy) * k,
    tilt: from.tilt + (to.tilt - from.tilt) * k,
  }
}

/** How open the eyes are during a blink (1 = not blinking) */
function blinkFactor(face: FaceState, time: number): number {
  const closeness = (start: number) => {
    const p = (time - start) / FACE.blinkDuration
    return p >= 0 && p <= 1 ? Math.sin(Math.PI * p) : 0
  }
  let c = closeness(face.blinkStart)
  if (face.doubleBlink) c = Math.max(c, closeness(face.blinkStart + FACE.doubleBlinkGap))
  return 1 - c * 0.92
}

/** The expression for an agent at work, or none while it has nothing to do */
function workingExpression(agent: Agent, displayed: AgentState, waitingOnSubagents: boolean): Expression | null {
  switch (displayed) {
    case 'tool_calling': return 'focus'
    case 'waiting_permission': return 'ask'
    case 'error': return 'upset'
    case 'thinking': return waitingOnSubagents && !WORKING.has(agent.state) ? 'watch' : 'ponder'
    default: return null // 'complete' and 'idle': nothing to do
  }
}

/**
 * The resting cycle, `idleFor` seconds into having nothing to do: it looks
 * around, sulks out the rest of FACE.boredDuration, then whistles for as long
 * again — and takes it from the top for as long as it is left alone.
 */
function restingExpression(idleFor: number): Expression {
  const phase = idleFor % (FACE.boredDuration * 2)
  if (phase >= FACE.boredDuration) return 'whistle'
  return phase < FACE.lookDuration ? 'awkward' : 'bored'
}

/**
 * What the face shows: what the agent is doing, or, with nothing to do, the
 * resting cycle above, which a last happy moment comes before. Work that
 * interrupts the whistling startles it first.
 */
function expressionFor(agent: Agent, displayed: AgentState, waitingOnSubagents: boolean, face: FaceState, time: number): Expression {
  const working = workingExpression(agent, displayed, waitingOnSubagents)
  if (working) {
    // Caught whistling: the eyes snap open before it takes the work up
    if (face.expression === 'whistle') face.startleUntil = time + FACE.startleDuration
    face.idleSince = 0
    return time < face.startleUntil ? 'startled' : working
  }
  if (face.idleSince === 0) {
    // Nothing left to do: a turn that has just ended is happy about it first
    face.idleSince = time
    if (AT_WORK.has(face.expression)) face.happyUntil = time + FACE.happyDuration
  }
  if (time < face.happyUntil) return 'happy'
  return restingExpression(time - face.idleSince)
}

/** How much a note coming out opens the pucker, `t` seconds after it left: it
 *  gives with the note, then tightens again for the next one */
function blowOpen(t: number): number {
  if (t < 0) return 0
  if (t < FACE.blowRise) return smooth(t / FACE.blowRise)
  const fall = (t - FACE.blowRise) / FACE.blowFall
  return fall >= 1 ? 0 : smooth(1 - fall)
}

/**
 * Whistle one blow at a time: it puckers up and shuts its eyes, lets out at
 * least WHISTLE.phraseMin notes, and only once the last one is away does the
 * pucker go and the eyes open for a breath. Every blow is its own length, with
 * its own rests, so the tune never comes out the same, and each one comes out
 * of the other corner of its mouth — the swap happens over the breath, while
 * the pucker is away. The notes drift off the side they left it on.
 */
function whistle(face: FaceState, cx: number, cy: number, r: number, color: string, time: number) {
  if (time < face.nextNote) return
  if (!face.blowing) {
    // Pucker up: the first note of the blow follows the lips closing
    face.blowing = true
    face.phraseLeft = WHISTLE.phraseMin + Math.floor(Math.random() * (WHISTLE.phraseRange + 1))
    face.nextNote = time + FACE.blowLead
    return
  }
  if (face.phraseLeft <= 0) {
    // The blow's last note is out: the pucker goes at once (it must not be
    // caught fading on the side the next blow comes out of), the eyes open,
    // and that next blow is the other side's
    face.blowing = false
    face.blow = 0
    face.whistleSide = face.whistleSide === -1 ? 1 : -1
    face.nextNote = time + WHISTLE.phraseGap + Math.random() * WHISTLE.phraseGapJitter
    return
  }
  face.phraseLeft--
  face.lastNote = time
  spawnNote(face.notes, cx + face.whistleSide * FACE.mouthX * r, cy + FACE.mouthY * r, r, face.whistleSide, color)
  face.nextNote = time + WHISTLE.noteGap + Math.random() * WHISTLE.noteGapJitter
}

/** The pucker it whistles through: a small oval off to the `side` this blow
 *  comes out of, tipped that way, there for as long as the blow lasts (`open`
 *  carries it in and out) */
function drawWhistle(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string,
  side: -1 | 1, alpha: number, open: number,
) {
  if (open < 0.02) return
  const mr = FACE.mouthRadius * r * open
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.strokeStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = FACE.glowBlur
  ctx.lineWidth = Math.max(1, r * 0.05)
  ctx.beginPath()
  ctx.ellipse(cx + side * FACE.mouthX * r, cy + FACE.mouthY * r, mr * 0.88, mr, side * 0.4, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/**
 * Advance and draw the main agent's face at (cx, cy) for radius r, in `color`.
 * The notes it whistles are drawn separately (they float free of the node, see
 * drawNotes), from the same `notes` this keeps filling.
 */
export function drawFace(
  ctx: CanvasRenderingContext2D,
  faces: Map<string, FaceState>,
  agent: Agent,
  displayed: AgentState,
  waitingOnSubagents: boolean,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  cx: number, cy: number, r: number,
  color: string,
  time: number,
): void {
  let face = faces.get(agent.id)
  if (!face) {
    face = newFace(time)
    faces.set(agent.id, face)
  }
  const expression = expressionFor(agent, displayed, waitingOnSubagents, face, time)
  if (face.expression !== expression) {
    face.expression = expression
    face.since = time
  }
  const dt = Math.min(Math.max(time - face.lastTime, 0), 0.1)
  face.lastTime = time
  const t = time - face.since

  // The eyes close into the happy arcs it whistles with over a blow, open
  // again for the breath between two of them, and snap open the moment it is
  // caught at it
  const blowing = expression === 'whistle' && face.blowing
  const overTune = expression === 'whistle'
  face.squint += ((blowing ? 1 : 0) - face.squint) * (1 - Math.exp(-dt * (overTune ? FACE.squintSpeed : FACE.squintOpenSpeed)))
  face.blow += ((blowing ? 1 : 0) - face.blow) * (1 - Math.exp(-dt * FACE.blowEase))
  const boredTarget = expression === 'bored' ? 1 : 0
  face.boredShape += (boredTarget - face.boredShape) * (1 - Math.exp(-dt * FACE.boredShapeSpeed))
  const motionTarget = expression === 'upset' || expression === 'happy' || expression === 'ask'
    || expression === 'awkward' || expression === 'bored' || expression === 'whistle' ? 1 : 0
  face.motion += (motionTarget - face.motion) * (1 - Math.exp(-dt * FACE.motionEase))

  // Whistling: notes out of the mouth; once it stops, the ones in the air
  // carry on drifting off on their own
  advanceNotes(face.notes, dt)
  if (expression === 'whistle') whistle(face, cx, cy, r, color, time)
  // Not whistling (or caught at it): the pucker goes at once, with the tune
  else { face.blowing = false; face.blow = 0; face.phraseLeft = 0; face.nextNote = time }

  // Quick glances while focused
  if (expression === 'focus' && time >= face.nextSaccade) {
    face.saccade = { x: (Math.random() - 0.5) * 0.35, y: (Math.random() - 0.5) * 0.25 }
    face.nextSaccade = time + 0.35 + Math.random() * 0.6
  } else if (expression !== 'focus') {
    face.saccade = { x: 0, y: 0 }
  }

  // Blinks now and then (sometimes twice), less often while focused, and not
  // once over a tune: through a blow the eyes are shut anyway, and between two
  // of them it is only resting them, not looking at anything
  if (time >= face.nextBlink) {
    const gap = FACE.blinkMinGap * (expression === 'focus' ? 1.6 : 1)
    face.nextBlink = time + gap + Math.random() * FACE.blinkJitter
    if (expression !== 'whistle') {
      face.blinkStart = time
      face.doubleBlink = Math.random() < FACE.doubleBlinkChance
      // A bored blink is what the gaze moves over: by the time the lids are
      // shut it is already looking somewhere else
      if (expression === 'bored') face.boredSwitchAt = time + FACE.blinkDuration / 2
    }
  }

  // …which is here, with the eyes at their darkest, and in one step (`snap`),
  // so nothing is ever seen sweeping from one side to the other
  let snap = false
  if (expression === 'bored') {
    if (face.boredSwitchAt > 0 && time >= face.boredSwitchAt) {
      face.boredLook = (face.boredLook + 1) % BORED_LOOKS.length
      face.boredSwitchAt = 0
      snap = true
    }
  } else {
    face.boredLook = 0
    face.boredSwitchAt = 0
  }

  const target = targetPose(face, gazeFor(face, agent, agents, toolCalls, time), t)
  const k = snap ? 1 : 1 - Math.exp(-dt * FACE.poseEase)
  face.pose = { left: lerpPose(face.pose.left, target.left, k), right: lerpPose(face.pose.right, target.right, k) }

  // The expression's own motion, on top of its pose
  let shakeX = 0, bobY = 0
  if (expression === 'upset') shakeX = Math.sin(t * 38) * (0.045 * Math.exp(-t * 1.6) + 0.006)
  else if (expression === 'happy') bobY = -Math.abs(Math.sin(t * 11)) * 0.05
  else if (expression === 'ask') bobY = Math.sin(t * 2.6) * 0.025
  else if (expression === 'awkward') shakeX = Math.sin(t * 1.9) * 0.025 // a nervous shuffle
  else if (expression === 'bored') bobY = Math.sin(t * 0.8) * 0.022 // a slow sigh
  else if (expression === 'whistle') {
    // Bobbing along to its own tune
    bobY = Math.sin(t * FACE.whistleBobSpeed) * FACE.whistleBobAmp
    shakeX = Math.sin(t * FACE.whistleBobSpeed * 0.5) * 0.014
  }
  shakeX *= face.motion
  bobY *= face.motion

  const lidOpen = blinkFactor(face, time) * (1 - face.squint)
  ctx.save()
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = FACE.glowBlur
  for (const [i, pose] of [face.pose.left, face.pose.right].entries()) {
    const side: -1 | 1 = i === 0 ? -1 : 1
    const w = FACE.eyeWidth * r * pose.sx
    const h = FACE.eyeWidth * FACE.eyeAspect * r * pose.sy * lidOpen
    ctx.save()
    ctx.translate(cx + (pose.x + shakeX) * r, cy + (pose.y + bobY) * r)
    ctx.rotate(pose.tilt)
    if (h >= 0.3) {
      // The sample's border-radius: 38% 38% 45% 45% (elliptical, of width and
      // height), squaring off at the top and rounding right off at the bottom
      // as the boredom takes the eye over
      const b = face.boredShape
      const top = { x: w * 0.38 * (1 - b), y: h * 0.38 * (1 - b) }
      const bottom = { x: w * (0.45 + 0.05 * b), y: h * (0.45 + 0.05 * b) }
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, [top, top, bottom, bottom])
      ctx.fill()
    }
    if (face.squint > 0.02) {
      // Closed and content: an arc bowed up, taking over as the eye flattens.
      // The one above the pucker is squeezed a little narrower.
      // (it follows the pucker, so it is gone the moment the blow is)
      const squeeze = side === face.whistleSide ? 1 - 0.12 * face.blow : 1
      const aw = FACE.arcWidth * r * pose.sx * squeeze
      ctx.save()
      ctx.globalAlpha *= face.squint
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, FACE.arcWeight * r)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(-aw / 2, 0)
      ctx.quadraticCurveTo(0, -FACE.arcLift * r * 2, aw / 2, 0)
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
  }
  ctx.restore()

  // The only mouth it has is the pucker, and only while it is blowing: it
  // holds for the whole blow, opening a touch with each note
  if (face.blow > 0.02) {
    const mouthX = cx + shakeX * r, mouthY = cy + bobY * r
    drawWhistle(ctx, mouthX, mouthY, r, color, face.whistleSide, face.blow, face.blow * (0.82 + 0.18 * blowOpen(time - face.lastNote)))
  }
}
