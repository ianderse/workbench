import { displayedState } from '../../hooks/graph/types'
import { Agent, NODE, ANIM, type ToolCallNode } from '../../lib/agent-types'
import { getStateColor } from '../../lib/colors'
import { AGENT_DRAW } from '../../lib/canvas-constants'
import { alphaHex } from '../../lib/utils'
import { drawPolygon, CLAUDE_SPARK_D } from './draw-misc'
import { drawFace, type FaceState } from './draw-face'
import { getAgentGlowSprite } from './render-cache'
import { AGENTS_ICON_PATH } from '../../../icons/app-icons'

/** The main agent is a pentagon, sub-agents hexagons */
const sidesOf = (agent: Agent) => (agent.isMain ? 5 : 6)

/** The agent's outline at radius r, as a path */
function drawNodeShape(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  drawPolygon(ctx, agent.x, agent.y, r, sidesOf(agent))
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
  ctx.shadowBlur = 6 / scale
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
  ctx.shadowBlur = 6 / scale
  ctx.fill(getAgentsIconPath())
  ctx.restore()
}

/** `pulse` dims the glow (1 = full brightness); it carries the active-state pulse,
 *  applied to the sprite as it's drawn so the cached sprites stay the same few */
function drawAgentGlow(
  ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean, pulse: number,
) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isWaiting ? 0.45 : agent.state === 'thinking' ? 0.3 : 0.1
  // Neon glow: strongest at the border (from the shape's edge midpoints, cos(180° / sides)
  // of its radius) and fading outward; the inside of the node is clipped out, so it stays clear
  const outer = Math.ceil(glowR)
  ctx.save()
  drawNodeShape(ctx, agent, r)
  ctx.rect(agent.x - outer, agent.y - outer, outer * 2, outer * 2)
  ctx.clip('evenodd')
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * Math.cos(Math.PI / sidesOf(agent))), outer, alphaHex(glowAlpha))
  ctx.globalAlpha *= pulse
  ctx.drawImage(sprite, agent.x - outer, agent.y - outer)
  ctx.restore()

  // Ambient outer ring
  drawNodeShape(ctx, agent, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = color + '25'
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawScanline(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean, time: number) {
  const scanSpeed = agent.state === 'thinking' || isWaiting ? ANIM.scanline.thinking : ANIM.scanline.normal
  const scanY = agent.y - r + ((time * scanSpeed) % (r * 2))
  ctx.save()
  drawNodeShape(ctx, agent, r)
  ctx.clip()
  const scanGrad = ctx.createLinearGradient(agent.x, scanY - AGENT_DRAW.scanlineHalfH, agent.x, scanY + AGENT_DRAW.scanlineHalfH)
  scanGrad.addColorStop(0, color + '00')
  scanGrad.addColorStop(0.5, color + '20')
  scanGrad.addColorStop(1, color + '00')
  ctx.fillStyle = scanGrad
  ctx.fillRect(agent.x - r, scanY - AGENT_DRAW.scanlineHalfH, r * 2, AGENT_DRAW.scanlineWidth)
  ctx.restore()
}

function drawStateRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean, time: number) {
  drawNodeShape(ctx, agent, r)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  // A waiting sub-agent's border runs as dashes (the main agent's face asks instead)
  if (isWaiting && !agent.isMain) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

/** A sub-agent's icon: a lock while it waits for permission, else the Agents icon
 *  (the main agent shows its face, see drawFace) */
function drawCenterIcon(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean) {
  if (isWaiting) {
    // Geometric lock icon — fits the holographic style
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1.5
    // Lock body (rounded rect)
    ctx.beginPath()
    ctx.roundRect(agent.x - s * 0.6, agent.y - s * 0.1, s * 1.2, s * 1.0, 2)
    ctx.fill()
    // Lock shackle (arc)
    ctx.beginPath()
    ctx.arc(agent.x, agent.y - s * 0.15, s * 0.4, Math.PI, 0)
    ctx.stroke()
    ctx.restore()
  } else {
    drawAgentsIcon(ctx, agent.x, agent.y, r, color)
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
 *  `faces`: the main agent's face animation, kept by the canvas between frames */
export function drawAgents(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  awaiting: Set<string>,
  toolCalls: Map<string, ToolCallNode>,
  faces: Map<string, FaceState>,
  time: number,
) {
  for (const stored of agents.values()) {
    const state = displayedState(stored, awaiting)
    const agent = state === stored.state ? stored : { ...stored, state }
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const color = getStateColor(agent.state)

    const isWaiting = agent.state === 'waiting_permission'
    const isActive = agent.state === 'thinking' || isWaiting

    const breathe = isWaiting
      ? Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1
      : agent.state === 'thinking'
      ? Math.sin(time * ANIM.breathe.thinkingSpeed) * ANIM.breathe.thinkingAmp + 1
      : agent.state === 'idle' ? Math.sin(time * ANIM.breathe.idleSpeed) * ANIM.breathe.idleAmp + 1 : 1

    const r = radius * breathe * agent.scale

    ctx.save()
    ctx.globalAlpha = agent.opacity

    drawAgentGlow(ctx, agent, r, color, isWaiting, glowPulse(isActive, time))
    drawScanline(ctx, agent, r, color, isWaiting, time)
    drawStateRing(ctx, agent, r, color, isWaiting, time)
    if (agent.isMain) {
      // Eyes while it works; the Claude spark (fading in as they close) while it doesn't
      const spark = drawFace(ctx, faces, stored, state, awaiting.has(agent.id), agents, toolCalls, agent.x, agent.y, r, color, time)
      if (spark > 0.01) {
        ctx.save()
        ctx.globalAlpha *= spark
        drawClaudeSpark(ctx, agent.x, agent.y, r, color)
        ctx.restore()
      }
    } else {
      drawCenterIcon(ctx, agent, r, color, isWaiting)
    }

    ctx.restore()
  }
}
