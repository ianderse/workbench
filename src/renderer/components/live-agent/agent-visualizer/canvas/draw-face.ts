import type { Agent, AgentState, ToolCallNode } from '../../lib/agent-types'
import { FACE, WHISTLE, ZZZ } from '../../lib/canvas-constants'
import { getStateColor } from '../../lib/colors'
import { advanceNotes, spawnNote, spawnZ, type WhistleNote } from './draw-notes'

/**
 * The main agent's face: two eyes (the shape of agent-flow's EMO sample: a
 * rounded rectangle 1.15 times as tall as wide, top corners 38%, bottom 45%)
 * that show how the agent is doing. Only how the eyes move changes with the
 * agent's state; their shape and color (the node's) don't.
 *
 * Left with nothing to do it whistles itself three to five blows — one at a
 * time, eyes shut happy over it and notes drifting out of its pucker (see
 * draw-notes.ts), eyes open again for the breath between two of them. Out of
 * tune, it sulks through two or three turns of the heavy lids sinking and
 * catching. Then sleep takes it: the lids come down over a gaze parked off to
 * one side, it catches itself and looks the other way, twice, and the third
 * time they stay down and the Zs start rising off its head. It is counted in
 * whole animations rather than seconds, so a blow or a sulk is never cut off
 * halfway (see startResting and advanceRest).
 *
 * None of that starts while the window it belongs to is still starting (see
 * `suspended`): behind the window's spinner there is nobody to whistle to.
 *
 * Nothing wakes it but work, and when that comes its eyes snap wide open and
 * the node turns over to the color of whatever it is now doing as they do (see
 * displayedColor).
 */

/** What the face shows */
type Expression =
  | 'ponder'   // thinking: gaze drifts up and around
  | 'focus'    // calling a tool: narrowed, looking at the tool
  | 'ask'      // waiting for permission: wide puppy eyes toward the terminal
  | 'upset'    // a tool failed: frowning, a shake
  | 'watch'    // waiting on sub-agents: following the newest one
  | 'happy'    // just finished its turn: a short laugh
  | 'bored'    // bored: flat lids over round eyes, sinking, still looking about
  | 'whistle'  // nothing to do: eyes closed happy, notes out of its mouth
  | 'sleepy'   // bored long enough: lids sinking, catching itself over and over
  | 'asleep'   // it gave in: eyes shut, head hanging, Zs rising off it
  | 'startled' // caught at it: eyes snapped open, taking it in
  | 'waiting'  // nothing to do yet: awake, blinking, nothing more

/** Where the face is in its resting cycle, once it has nothing to do */
type Rest = 'whistle' | 'bored' | 'sleepy' | 'asleep'

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
  /** How heavy the lids are: 0 wide awake, 1 shut for the night. It comes down
   *  over a close, springs back when it catches itself, and only stays at 1
   *  once it is asleep */
  drowse: number
  /** Where it is in the resting cycle, and how much of each phase is left to
   *  play: blows still to whistle, sulks still to sit through */
  rest: Rest
  whistlesLeft: number
  sulksLeft: number
  /** When the sulk it is on has sunk and caught itself, so the next can start
   *  (or, with none left, sleep can) */
  sulkEnd: number
  /** Falling asleep: the lids are either coming down (since `closeFrom`, toward
   *  `closeSide`) or being held open until `openUntil` after catching itself,
   *  with `savesLeft` of those left before the close it sleeps through */
  closing: boolean
  closeFrom: number
  closeSide: -1 | 1
  savesLeft: number
  openUntil: number
  /** The color it is drawn in on the way to its state's own (see
   *  displayedColor), when that was last moved along, and how long it is still
   *  being eased for, toward which color (only the moment after work has woken
   *  it, toward that work's) */
  rgb: [number, number, number] | null
  rgbTime: number
  colorEaseUntil: number
  colorEaseTo: string
  /** Which of the three Z sizes comes next, and when */
  zStep: number
  nextZ: number
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

/** Resting states work has to pull it out of: it is startled out of these */
const RESTING_DEEP: ReadonlySet<Expression> = new Set(['whistle', 'sleepy', 'asleep'])

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
    drowse: 0,
    rest: 'whistle',
    whistlesLeft: 0,
    sulksLeft: 0,
    sulkEnd: 0,
    closing: true,
    closeFrom: 0,
    closeSide: -1,
    savesLeft: 0,
    openUntil: 0,
    rgb: null,
    rgbTime: time,
    colorEaseUntil: 0,
    colorEaseTo: '',
    zStep: 0,
    nextZ: 0,
    expression: 'waiting',
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

/**
 * How heavy the lids are while it is falling asleep: they come down over
 * FACE.sleepyClose, and the moment it catches itself they are pulled back up
 * (fast, see the rates in drawFace) and held there until the next close takes
 * over. The close it sleeps through is the same curve, just with nothing on
 * the other end of it.
 */
function drowseAt(face: FaceState, time: number): number {
  if (!face.closing) return 0
  // Only the close it sleeps through shuts the eyes: the ones it catches
  // itself out of leave them a bored sliver, open enough to still be eyes
  const far = face.savesLeft > 0 ? FACE.sleepyShut : 1
  return far * smooth(Math.min(1, (time - face.closeFrom) / FACE.sleepyClose))
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
    case 'sleepy':
      // The lids come down over a gaze parked off to one side, as when bored,
      // and take it further that way and further down as they fall. Catching
      // itself brings it back to the front, wide awake for a moment, and the
      // close after that is the other side's
      return face.closing
        ? {
            x: FACE.boredLookX * face.closeSide * (0.45 + 0.55 * face.drowse),
            y: FACE.boredGazeY + 0.3 * face.drowse,
          }
        : { x: 0, y: -0.06 }
    case 'asleep':
      // Nothing to look at: the eyes are shut and the head hangs
      return { x: 0, y: 0.3 }
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
      case 'sleepy':
        if (!face.closing) {
          // Caught itself: the eyes come back the size and shape they are when
          // it is wide awake (the bored lid goes with them, see boredTarget)
          break
        }
        // Going under: the bored eye, wider, shorter and lower the heavier the
        // lids get. How far they have actually come down is `drowse`, which
        // closes the eye itself (see drawFace)
        pose.sx = 1.2
        pose.sy = 0.62
        pose.y += 0.04 + 0.05 * face.drowse
        pose.tilt = side * 0.12 // outer corners down: giving up on the day
        break
      case 'asleep':
        pose.sx = 1.1
        pose.sy = 0.5
        pose.y += 0.07
        pose.tilt = side * 0.1
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
 * Set the resting cycle going: so many blows to whistle and so many sulks to
 * sit through, drawn afresh every time it is left alone, so the idle stretch
 * never plays out the same way twice. Each phase is counted out in whole
 * animations and hands over only when the one it is playing has finished (see
 * advanceRest), which is what keeps a blow or a sulk from being cut off.
 */
function startResting(face: FaceState) {
  face.rest = 'whistle'
  face.whistlesLeft = FACE.whistlesMin + Math.floor(Math.random() * (FACE.whistlesRange + 1))
  face.sulksLeft = FACE.sulksMin + Math.floor(Math.random() * (FACE.sulksRange + 1))
}

/** The lids start coming down toward `side`, from here */
function startClosing(face: FaceState, side: -1 | 1, time: number) {
  face.closing = true
  face.closeFrom = time
  face.closeSide = side
}

/**
 * Carry the resting cycle on, once an animation it was playing is done:
 * - the sulk it is on has sunk and caught itself, and it has no more to sit
 *   through: the lids start coming down for good
 * - the lids are all the way down: it catches itself, looks the other way and
 *   lets them come down again — until the last save is spent, and that close
 *   is the one it sleeps through
 * (a blow is counted off in `whistle`, which is where one ends)
 */
function advanceRest(face: FaceState, time: number) {
  if (face.rest === 'bored' && time >= face.sulkEnd) {
    if (--face.sulksLeft > 0) face.sulkEnd = time + FACE.sagCycle
    else {
      face.rest = 'sleepy'
      face.savesLeft = FACE.sleepySaves
      startClosing(face, -1, time)
    }
    return
  }
  if (face.rest !== 'sleepy') return
  if (face.closing) {
    if (time - face.closeFrom < FACE.sleepyClose) return
    if (face.savesLeft <= 0) {
      // Nothing left to fight it off with: this close is the one it sleeps
      // through (drawFace starts the Zs once the lids are down)
      face.rest = 'asleep'
      return
    }
    // Caught itself: the eyes come back wide open for a moment
    face.savesLeft--
    face.closing = false
    face.openUntil = time + FACE.sleepyOpenHold
    return
  }
  // Held itself open long enough: down they come again, the other way this time
  if (time >= face.openUntil) startClosing(face, face.closeSide === -1 ? 1 : -1, time)
}

/**
 * What the face shows: what the agent is doing, or, with nothing to do, the
 * resting cycle above, which a last happy moment comes before. Work that
 * interrupts the whistling startles it first.
 */
function expressionFor(agent: Agent, displayed: AgentState, waitingOnSubagents: boolean, face: FaceState, time: number, suspended: boolean, replaying: boolean): Expression {
  // A rebuilt graph replays its session in one frame: those states already
  // happened, so the face holds what it was doing instead of being woken by
  // work from the past and starting its resting cycle over
  if (replaying) return face.expression
  const working = workingExpression(agent, displayed, waitingOnSubagents)
  if (working) {
    // Caught whistling, or fast asleep: the eyes snap wide open and take in
    // who wants it now, while the node turns over to that work's own color
    // (the one change worth easing, see displayedColor)
    if (RESTING_DEEP.has(face.expression)) face.startleUntil = time + FACE.startleDuration
    face.idleSince = 0
    return time < face.startleUntil ? 'startled' : working
  }
  if (suspended && face.idleSince === 0) {
    // The window is still starting and the graph is behind its spinner: the
    // resting cycle waits for it rather than playing to nobody, so whoever is
    // watching sees it whistle from the first blow. One already under way goes
    // on (a session being opened, its spinner over the one still shown):
    // nothing wakes it but work
    return 'waiting'
  }
  if (face.idleSince === 0) {
    // Nothing left to do: a turn that has just ended is happy about it first
    face.idleSince = time
    startResting(face)
    if (AT_WORK.has(face.expression)) face.happyUntil = time + FACE.happyDuration
  }
  if (time < face.happyUntil) return 'happy'
  // Awake and doing nothing for a moment first: whistling the instant there is
  // nothing to do caught every session that came back to life a beat later
  if (time - face.idleSince < FACE.restLead) return 'waiting'
  advanceRest(face, time)
  // Each part of the cycle is the expression of the same name
  return face.rest
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
    // That is one of the blows it had in it. With the last one out it has no
    // tune left and sits down to sulk, which is why a blow is never cut off
    // halfway: the count only runs down here, between two of them
    if (--face.whistlesLeft <= 0) {
      face.rest = 'bored'
      face.sulkEnd = time + FACE.sagCycle
    }
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

/** A #rrggbb string as its three channels */
function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** How far apart the eased colors are, per channel (see displayedColor) */
const COLOR_STEP = 6

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')

/**
 * The color to draw the main agent in: its state's own, and for the moment
 * after work has woken it, eased on the way there — the one change the node
 * makes something of, since it is coming round rather than carrying on. Every
 * other change is its new color at once, as for any other node, and so is one
 * that comes along while the wake is still easing. The glow and the ring take it
 * from here too, so the node turns over with the face rather than around it.
 *
 * The eased color moves in steps of COLOR_STEP per channel, too small to see:
 * the glow's sprite is cached by color, and a new color every frame built a
 * new sprite every frame of the ease.
 */
export function displayedColor(faces: Map<string, FaceState>, id: string, state: AgentState, time: number): string {
  const target = getStateColor(state)
  const face = faces.get(id)
  if (!face) return target
  const to = channels(target)
  if (!face.rgb) {
    face.rgb = to
    face.rgbTime = time
    return target
  }
  // Waking is noticed here rather than in drawFace: the glow and the ring need
  // the color before the face has been advanced, so this call comes first and
  // work's color arriving while the face is still resting is the wake itself.
  // Any other change it sleeps through (a finished agent coming back idle) is cut
  const differs = Math.abs(face.rgb[0] - to[0]) + Math.abs(face.rgb[1] - to[1]) + Math.abs(face.rgb[2] - to[2]) > 2
  if (differs && WORKING.has(state) && RESTING_DEEP.has(face.expression)) {
    face.colorEaseUntil = time + FACE.colorEaseWindow
    face.colorEaseTo = target
  }
  if (time >= face.colorEaseUntil || target !== face.colorEaseTo) {
    face.colorEaseUntil = 0
    face.rgb = to
    face.rgbTime = time
    return target
  }
  const dt = Math.min(Math.max(time - face.rgbTime, 0), 0.1)
  face.rgbTime = time
  const k = 1 - Math.exp(-dt * FACE.colorEase)
  face.rgb = [
    face.rgb[0] + (to[0] - face.rgb[0]) * k,
    face.rgb[1] + (to[1] - face.rgb[1]) * k,
    face.rgb[2] + (to[2] - face.rgb[2]) * k,
  ]
  const step = (v: number) => hex2(Math.round(v / COLOR_STEP) * COLOR_STEP)
  return `#${step(face.rgb[0])}${step(face.rgb[1])}${step(face.rgb[2])}`
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
  /** The window is still starting: hold the resting cycle until it is shown */
  suspended: boolean,
  /** This frame replays a rebuilt graph's history: the face sits it out */
  replaying: boolean,
): void {
  let face = faces.get(agent.id)
  if (!face) {
    face = newFace(time)
    faces.set(agent.id, face)
  }
  const expression = expressionFor(agent, displayed, waitingOnSubagents, face, time, suspended, replaying)
  if (face.expression !== expression) {
    face.expression = expression
    face.since = time
    // Every sleep's Zs climb from the smallest, wherever the last one's stopped
    if (expression === 'asleep') { face.nextZ = time + ZZZ.gap; face.zStep = 0 }
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
  // The lids sink over a nod and the jolt pulls them back, so they follow
  // their weight at two speeds; waking up is faster still. `jolt` is how hard
  // they are being pulled open right now, which the shiver below goes with
  const wasDrowse = face.drowse
  const drowseTarget = expression === 'sleepy' ? drowseAt(face, time) : expression === 'asleep' ? 1 : 0
  const drowseSpeed = drowseTarget >= face.drowse || expression === 'asleep'
    ? FACE.drowseSpeed
    : expression === 'sleepy' ? FACE.joltSpeed : FACE.wakeSpeed
  face.drowse += (drowseTarget - face.drowse) * (1 - Math.exp(-dt * drowseSpeed))
  const jolt = expression === 'sleepy' ? Math.max(0, (wasDrowse - face.drowse) / Math.max(dt, 1e-3)) : 0

  // Sleep keeps the bored eye: the lid stays flat over it as it closes, and
  // only lifts off when it catches itself, where the eye is its own shape again
  const saved = expression === 'sleepy' && !face.closing
  const boredTarget = !saved && (expression === 'bored' || expression === 'sleepy' || expression === 'asleep') ? 1 : 0
  face.boredShape += (boredTarget - face.boredShape) * (1 - Math.exp(-dt * (saved ? FACE.wakeEase : FACE.boredShapeSpeed)))
  const motionTarget = expression === 'upset' || expression === 'happy' || expression === 'ask'
    || expression === 'bored' || expression === 'whistle'
    || expression === 'sleepy' || expression === 'asleep' ? 1 : 0
  face.motion += (motionTarget - face.motion) * (1 - Math.exp(-dt * FACE.motionEase))

  // Whistling: notes out of the mouth; once it stops, the ones in the air
  // carry on drifting off on their own
  advanceNotes(face.notes, dt)
  if (expression === 'whistle') whistle(face, cx, cy, r, color, time)
  // Not whistling (or caught at it): the pucker goes at once, with the tune
  else { face.blowing = false; face.blow = 0; face.phraseLeft = 0; face.nextNote = time }

  // Asleep: a Z rises off its head now and then, the three sizes in turn, so
  // they climb away from it as one "Zzz"
  if (expression === 'asleep' && time >= face.nextZ) {
    spawnZ(face.notes, cx + ZZZ.fromX * r, cy + ZZZ.fromY * r, r, face.zStep, 1, color)
    face.zStep = (face.zStep + 1) % ZZZ.sizes.length
    face.nextZ = time + ZZZ.gap + Math.random() * ZZZ.gapJitter
  }

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
    if (expression !== 'whistle' && expression !== 'asleep' && face.drowse < 0.5) {
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
  // Catching itself is the one thing the eyes do quickly: the pose comes back
  // with the lids rather than easing along behind them
  const poseRate = expression === 'sleepy' && !face.closing ? FACE.wakeEase : FACE.poseEase
  const k = snap ? 1 : 1 - Math.exp(-dt * poseRate)
  face.pose = { left: lerpPose(face.pose.left, target.left, k), right: lerpPose(face.pose.right, target.right, k) }

  // The expression's own motion, on top of its pose
  let shakeX = 0, bobY = 0
  if (expression === 'upset') shakeX = Math.sin(t * 38) * (0.045 * Math.exp(-t * 1.6) + 0.006)
  else if (expression === 'happy') bobY = -Math.abs(Math.sin(t * 11)) * 0.05
  else if (expression === 'ask') bobY = Math.sin(t * 2.6) * 0.025
  else if (expression === 'bored') bobY = Math.sin(t * 0.8) * 0.022 // a slow sigh
  else if (expression === 'sleepy') {
    // The head goes down with the lids and comes back up with them; the shiver
    // is the save itself, so it only happens when it really catches itself
    bobY = face.drowse * FACE.nodAmp
    shakeX = Math.sin(time * 34) * FACE.nodShake * Math.min(1, jolt * 0.4)
  }
  else if (expression === 'asleep') bobY = FACE.sleepHang * face.drowse + Math.sin(t * FACE.sleepBreathSpeed) * FACE.sleepBreathAmp
  else if (expression === 'whistle') {
    // Bobbing along to its own tune
    bobY = Math.sin(t * FACE.whistleBobSpeed) * FACE.whistleBobAmp
    shakeX = Math.sin(t * FACE.whistleBobSpeed * 0.5) * 0.014
  }
  shakeX *= face.motion
  bobY *= face.motion

  // A shut lid draws an arc instead of the eye: the happy one it whistles
  // behind, or, once sleep has the eyes, the same arc dipped the other way —
  // relaxed rather than pleased. The eye is down to nothing by the time that
  // arc comes in, so the two are never drawn over each other, which looked
  // like one eye with two outlines through every closing and opening
  const closed = Math.max(face.squint, face.drowse)
  const lidOpen = blinkFactor(face, time) * Math.max(0, 1 - closed / FACE.lidHandover)
  const shut = Math.max(0, (closed - FACE.arcFrom) / (1 - FACE.arcFrom))
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
    if (shut > 0.02) {
      // Closed and content: an arc bowed up, taking over as the eye flattens.
      // The one above the pucker is squeezed a little narrower.
      // (it follows the pucker, so it is gone the moment the blow is)
      const squeeze = side === face.whistleSide ? 1 - 0.12 * face.blow : 1
      const aw = FACE.arcWidth * r * pose.sx * squeeze
      const lift = face.drowse > face.squint ? -FACE.sleepArcDip : FACE.arcLift
      ctx.save()
      ctx.globalAlpha *= shut
      ctx.strokeStyle = color
      ctx.lineWidth = Math.max(1, FACE.arcWeight * r)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(-aw / 2, 0)
      ctx.quadraticCurveTo(0, -lift * r * 2, aw / 2, 0)
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
