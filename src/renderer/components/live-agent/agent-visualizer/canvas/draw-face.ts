import type { Agent, AgentState, ToolCallNode } from '../../lib/agent-types'
import { FACE } from '../../lib/canvas-constants'

/**
 * The main agent's face: two eyes (the shape of agent-flow's EMO sample: a
 * rounded rectangle 1.15 times as tall as wide, top corners 38%, bottom 45%)
 * that show how the agent is doing. Only how the eyes move changes with the
 * agent's state; their shape and color (the node's) don't. Once the agent has
 * finished its turn the eyes close and the Claude spark shows instead.
 */

/** What the face shows */
type Expression =
  | 'ponder'  // thinking: gaze drifts up and around
  | 'focus'   // calling a tool: narrowed, looking at the tool
  | 'ask'     // waiting for permission: wide puppy eyes toward the terminal
  | 'upset'   // a tool failed: frowning, a shake
  | 'watch'   // waiting on sub-agents: following the newest one
  | 'happy'   // just finished its turn: a short laugh before resting
  | 'awkward' // idle: uneven eyes looking away, sneaking glances back
  | 'rest'    // done: eyes closed, the spark shows

/** One eye, in node radii from the node's center (x, y), scaled (sx, sy) and tilted (radians) */
interface EyePose { x: number; y: number; sx: number; sy: number; tilt: number }
interface FacePose { left: EyePose; right: EyePose }

/** A face's animation state, kept between frames (per canvas, see AgentCanvas) */
export interface FaceState {
  pose: FacePose
  /** 0 closed (the spark shows) to 1 open */
  open: number
  /** Strength of the expression's own motion (shake, laugh, bob), eased in and out */
  motion: number
  expression: Expression
  /** When the expression started (graph clock seconds) */
  since: number
  lastTime: number
  /** The happy laugh after a turn lasts until this time */
  happyUntil: number
  nextBlink: number
  blinkStart: number
  doubleBlink: boolean
  /** A quick glance away (focus), and when the next one comes */
  saccade: { x: number; y: number }
  nextSaccade: number
}

const WORKING: ReadonlySet<AgentState> = new Set(['thinking', 'tool_calling', 'waiting_permission', 'error'])

const restingEye = (side: -1 | 1): EyePose => ({ x: side * FACE.eyeOffsetX, y: FACE.eyeOffsetY, sx: 1, sy: 1, tilt: 0 })

function newFace(expression: Expression, time: number): FaceState {
  return {
    pose: { left: restingEye(-1), right: restingEye(1) },
    open: expression === 'rest' ? 0 : 1,
    motion: 0,
    expression,
    since: time,
    lastTime: time,
    happyUntil: 0,
    nextBlink: time + FACE.blinkMinGap + Math.random() * FACE.blinkJitter,
    blinkStart: -Infinity,
    doubleBlink: false,
    saccade: { x: 0, y: 0 },
    nextSaccade: time,
  }
}

/** Unit vector from the agent toward a point, or none if it's on top of it */
function toward(agent: Agent, x: number, y: number): { x: number; y: number } | null {
  const dx = x - agent.x, dy = y - agent.y
  const d = Math.hypot(dx, dy)
  return d < 1 ? null : { x: dx / d, y: dy / d }
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
    default:
      return { x: 0, y: 0 }
  }
}

/** The pose an expression holds (before blinks and its own motion) */
function targetPose(face: FaceState, gaze: { x: number; y: number }): FacePose {
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

/** The expression for the agent's state, and what the face was doing */
function expressionFor(agent: Agent, displayed: AgentState, waitingOnSubagents: boolean, face: FaceState | undefined, time: number): Expression {
  if (displayed === 'tool_calling') return 'focus'
  if (displayed === 'waiting_permission') return 'ask'
  if (displayed === 'error') return 'upset'
  if (displayed === 'thinking') return waitingOnSubagents && !WORKING.has(agent.state) ? 'watch' : 'ponder'
  if (displayed === 'idle') return 'awkward'
  // Done: a turn that just ended is happy for a moment first
  if (face && face.expression !== 'rest' && face.expression !== 'happy' && face.expression !== 'upset' && displayed === 'complete') {
    face.happyUntil = time + FACE.happyDuration
  }
  return face && time < face.happyUntil ? 'happy' : 'rest'
}

/**
 * Advance and draw the main agent's face at (cx, cy) for radius r, in `color`.
 * Returns how visible the Claude spark should be (1 - how open the eyes are).
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
): number {
  let face = faces.get(agent.id)
  const expression = expressionFor(agent, displayed, waitingOnSubagents, face, time)
  if (!face) {
    face = newFace(expression, time)
    faces.set(agent.id, face)
  }
  if (face.expression !== expression) {
    face.expression = expression
    face.since = time
  }
  const dt = Math.min(Math.max(time - face.lastTime, 0), 0.1)
  face.lastTime = time

  // Open while there's something to show; closing reads as a slow blink into the spark
  const openTarget = expression === 'rest' ? 0 : 1
  face.open += (openTarget - face.open) * (1 - Math.exp(-dt * FACE.openSpeed))
  const motionTarget = expression === 'upset' || expression === 'happy' || expression === 'ask' || expression === 'awkward' ? 1 : 0
  face.motion += (motionTarget - face.motion) * (1 - Math.exp(-dt * FACE.motionEase))

  // Quick glances while focused
  if (expression === 'focus' && time >= face.nextSaccade) {
    face.saccade = { x: (Math.random() - 0.5) * 0.35, y: (Math.random() - 0.5) * 0.25 }
    face.nextSaccade = time + 0.35 + Math.random() * 0.6
  } else if (expression !== 'focus') {
    face.saccade = { x: 0, y: 0 }
  }

  // Blinks now and then (sometimes twice), less often while focused
  if (time >= face.nextBlink && face.open > 0.9) {
    face.blinkStart = time
    face.doubleBlink = Math.random() < FACE.doubleBlinkChance
    const gap = FACE.blinkMinGap * (expression === 'focus' ? 1.6 : 1)
    face.nextBlink = time + gap + Math.random() * FACE.blinkJitter
  }

  const target = targetPose(face, gazeFor(face, agent, agents, toolCalls, time))
  const k = 1 - Math.exp(-dt * FACE.poseEase)
  face.pose = { left: lerpPose(face.pose.left, target.left, k), right: lerpPose(face.pose.right, target.right, k) }

  if (face.open > 0.02) {
    // The expression's own motion, on top of its pose
    const t = time - face.since
    let shakeX = 0, bobY = 0
    if (expression === 'upset') shakeX = Math.sin(t * 38) * (0.045 * Math.exp(-t * 1.6) + 0.006)
    else if (expression === 'happy') bobY = -Math.abs(Math.sin(t * 11)) * 0.05
    else if (expression === 'ask') bobY = Math.sin(t * 2.6) * 0.025
    else if (expression === 'awkward') shakeX = Math.sin(t * 1.9) * 0.025 // a nervous shuffle
    shakeX *= face.motion
    bobY *= face.motion

    const lidOpen = blinkFactor(face, time) * face.open
    ctx.save()
    ctx.globalAlpha *= Math.min(1, face.open * 1.6)
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = FACE.glowBlur
    for (const pose of [face.pose.left, face.pose.right]) {
      const w = FACE.eyeWidth * r * pose.sx
      const h = FACE.eyeWidth * FACE.eyeAspect * r * pose.sy * lidOpen
      if (h < 0.3) continue
      ctx.save()
      ctx.translate(cx + (pose.x + shakeX) * r, cy + (pose.y + bobY) * r)
      ctx.rotate(pose.tilt)
      // The sample's border-radius: 38% 38% 45% 45% (elliptical, of width and height)
      const top = { x: w * 0.38, y: h * 0.38 }
      const bottom = { x: w * 0.45, y: h * 0.45 }
      ctx.beginPath()
      ctx.roundRect(-w / 2, -h / 2, w, h, [top, top, bottom, bottom])
      ctx.fill()
      ctx.restore()
    }
    ctx.restore()
  }

  return 1 - face.open
}
