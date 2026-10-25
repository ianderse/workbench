import { displayedState } from '../../hooks/graph/types'
import { Agent, ANIM, type AgentState, type ToolCallNode } from '../../lib/agent-types'
import { getStateColor } from '../../lib/colors'
import { AGENT_DRAW, FACE } from '../../lib/canvas-constants'
import { alphaHex } from '../../lib/utils'
import { CLAUDE_SPARK_D } from './draw-misc'
import { displayedColor, drawFace, type FaceState } from './draw-face'
import { drawNotes } from './draw-notes'
import { getAgentGlowSprite } from './render-cache'
import { AGENTS_ICON_PATH } from '../../../icons/app-icons'
import { drawJellyShape, applyJellyStretch, shapeInradius, type NodeMotion } from '../../lib/jelly'
import { clipOutsideAttached } from './node-motion'

/** The agent's border at radius r, as a path, as the jelly has it: rounded,
 *  bowed, squashed, and drawn out toward whatever it is gooed to (see lib/jelly.ts) */
function pathShape(ctx: CanvasRenderingContext2D, motion: NodeMotion, r: number, time: number) {
  drawJellyShape(ctx, motion.x, motion.y, r, motion.sides, motion.rotation, motion, time)
}

let _claudeSparkPath: Path2D | null = null
function getClaudeSparkPath() {
  if (!_claudeSparkPath) _claudeSparkPath = new Path2D(CLAUDE_SPARK_D)
  return _claudeSparkPath
}

function drawClaudeSpark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / AGENT_DRAW.sparkViewBox
  ctx.scale(scale, scale)
  ctx.translate(-AGENT_DRAW.sparkViewBox, -AGENT_DRAW.sparkViewBox + 1)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = FACE.glowBlur / 4
  ctx.fill(getClaudeSparkPath())
  ctx.restore()
}

let _agentsIconPath: Path2D | null = null
function getAgentsIconPath() {
  if (!_agentsIconPath) _agentsIconPath = new Path2D(AGENTS_ICON_PATH)
  return _agentsIconPath
}

/** The Agents menu icon (a pixel creature on a 1024 artboard, its figure spanning
 *  x 0–1024 and y 213–853), centered on the node */
function drawAgentsIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.subIconScale) / 1024
  ctx.scale(scale, scale)
  ctx.translate(-512, -533)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = FACE.glowBlur / 4
  ctx.fill(getAgentsIconPath())
  ctx.restore()
}

/** `pulse` dims the glow (1 = full brightness); it carries the active-state pulse,
 *  applied to the sprite as it's drawn so the cached sprites stay the same few */
function drawAgentGlow(
  ctx: CanvasRenderingContext2D, motion: NodeMotion, r: number, color: string,
  state: AgentState, isWaiting: boolean, pulse: number, time: number,
) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isWaiting ? 0.45 : state === 'thinking' ? 0.3 : 0.1
  // Neon glow: strongest at the border (from where the shape is nearest its
  // center) and fading outward; the inside of the node is clipped out, so it stays clear
  const outer = Math.ceil(glowR)
  ctx.save()
  pathShape(ctx, motion, r, time)
  ctx.rect(motion.x - outer, motion.y - outer, outer * 2, outer * 2)
  ctx.clip('evenodd')
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(shapeInradius(r, motion.sides)), outer, alphaHex(glowAlpha))
  ctx.globalAlpha *= pulse
  applyJellyStretch(ctx, motion)
  ctx.drawImage(sprite, motion.x - outer, motion.y - outer)
  ctx.restore()

  // Ambient outer ring
  pathShape(ctx, motion, r + AGENT_DRAW.outerRingOffset, time)
  ctx.strokeStyle = color + '25'
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawScanline(
  ctx: CanvasRenderingContext2D, motion: NodeMotion, r: number, color: string,
  state: AgentState, isWaiting: boolean, time: number,
) {
  const scanSpeed = state === 'thinking' || isWaiting ? ANIM.scanline.thinking : ANIM.scanline.normal
  const scanY = motion.y - r + ((time * scanSpeed) % (r * 2))
  ctx.save()
  pathShape(ctx, motion, r, time)
  ctx.clip()
  const scanGrad = ctx.createLinearGradient(motion.x, scanY - AGENT_DRAW.scanlineHalfH, motion.x, scanY + AGENT_DRAW.scanlineHalfH)
  scanGrad.addColorStop(0, color + '00')
  scanGrad.addColorStop(0.5, color + '20')
  scanGrad.addColorStop(1, color + '00')
  ctx.fillStyle = scanGrad
  ctx.fillRect(motion.x - r, scanY - AGENT_DRAW.scanlineHalfH, r * 2, AGENT_DRAW.scanlineWidth)
  ctx.restore()
}

function drawStateRing(
  ctx: CanvasRenderingContext2D, motion: NodeMotion, r: number, color: string,
  isMain: boolean, isWaiting: boolean, time: number,
) {
  pathShape(ctx, motion, r, time)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  // A waiting sub-agent's border runs as dashes (the main agent's face asks instead)
  if (isWaiting && !isMain) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

/** A sub-agent's icon: a lock while it waits for permission, the Claude spark
 *  for a background session the user started, else the Agents icon (the main
 *  agent shows its face instead, see drawFace) */
function drawCenterIcon(
  ctx: CanvasRenderingContext2D, motion: NodeMotion, r: number, color: string, isWaiting: boolean, isSatellite: boolean,
) {
  if (isWaiting) {
    // Geometric lock icon — fits the holographic style
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1.5
    // Lock body (rounded rect)
    ctx.beginPath()
    ctx.roundRect(motion.x - s * 0.6, motion.y - s * 0.1, s * 1.2, s * 1.0, 2)
    ctx.fill()
    // Lock shackle (arc)
    ctx.beginPath()
    ctx.arc(motion.x, motion.y - s * 0.15, s * 0.4, Math.PI, 0)
    ctx.stroke()
    ctx.restore()
  } else if (isSatellite) {
    drawClaudeSpark(ctx, motion.x, motion.y, r, color)
  } else {
    drawAgentsIcon(ctx, motion.x, motion.y, r, color)
  }
}

/** Pulse for an active agent (thinking or waiting for permission): its glow
 *  brightens and dims, between `glowPulseTrough` of full brightness and full. */
function glowPulse(isActive: boolean, time: number) {
  if (!isActive) return 1
  const trough = AGENT_DRAW.glowPulseTrough
  return trough + (1 - trough) * (Math.sin(time * AGENT_DRAW.glowPulseSpeed) * 0.5 + 0.5)
}

/** `awaiting`: the agents waiting on their sub-agents (see displayedState);
 *  `faces`: the main agent's face animation, kept by the canvas between frames;
 *  `motions`: where the jelly has each node this frame (see node-motion.ts) */
export function drawAgents(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  awaiting: Set<string>,
  toolCalls: Map<string, ToolCallNode>,
  faces: Map<string, FaceState>,
  motions: Map<string, NodeMotion>,
  time: number,
  /** The window is still starting: the main agent's resting cycle waits for it */
  suspended: boolean,
  /** This frame applies a rebuilt graph's history: its states are a replay of
   *  what already happened, so the faces sit it out */
  replaying: boolean,
) {
  for (const agent of agents.values()) {
    const state = displayedState(agent, awaiting)
    // Drawn where the jelly has it: out of its parent as it buds off, back in as it merges
    const motion = motions.get(agent.id)
    if (!motion) continue
    // The main agent's color is eased, so waking up into work turns the whole
    // node over from one state's color to the next instead of cutting to it
    const color = agent.isMain
      ? displayedColor(faces, agent.id, state, time)
      : getStateColor(state)

    const isWaiting = state === 'waiting_permission'
    const isActive = state === 'thinking' || isWaiting
    const r = motion.radius * motion.scale

    ctx.save()
    ctx.globalAlpha = agent.opacity
    // Where it is gooed to its parent or to a node coming out of it, the two
    // borders are one shape: keep what each draws out of the other
    clipOutsideAttached(ctx, motion, motions, time)

    drawAgentGlow(ctx, motion, r, color, state, isWaiting, glowPulse(isActive, time), time)
    drawScanline(ctx, motion, r, color, state, isWaiting, time)
    drawStateRing(ctx, motion, r, color, agent.isMain, isWaiting, time)

    // What the node holds is squashed and stretched with it
    ctx.save()
    applyJellyStretch(ctx, motion)
    if (agent.isMain) {
      // The main agent always has its face on: at work, or bored and whistling
      drawFace(ctx, faces, agent, state, awaiting.has(agent.id), agents, toolCalls, motion.x, motion.y, r, color, time, suspended, replaying)
    } else {
      drawCenterIcon(ctx, motion, r, color, isWaiting, agent.isSatellite === true)
    }
    ctx.restore()

    ctx.restore()
  }

  // The whistled notes are in the air, not in the body: drawn over every node,
  // outside its clip and its squash, and still drifting off after it stopped
  for (const agent of agents.values()) {
    const face = faces.get(agent.id)
    if (face && face.notes.length > 0) drawNotes(ctx, face.notes, agent.opacity)
  }
}
