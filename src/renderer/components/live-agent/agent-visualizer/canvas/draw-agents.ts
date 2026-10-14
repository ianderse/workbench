import { displayedState } from '../../hooks/graph/types'
import { Agent, NODE, ANIM } from '../../lib/agent-types'
import { COLORS, getStateColor } from '../../lib/colors'
import { AGENT_DRAW } from '../../lib/canvas-constants'
import { alphaHex } from '../../lib/utils'
import { drawHexagon, CLAUDE_SPARK_D } from './draw-misc'
import { getAgentGlowSprite } from './render-cache'

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

function drawDepthShadow(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = AGENT_DRAW.shadowBlur
  ctx.shadowOffsetX = AGENT_DRAW.shadowOffsetX
  ctx.shadowOffsetY = AGENT_DRAW.shadowOffsetY
  drawHexagon(ctx, agent.x, agent.y, r * 0.9)
  ctx.fillStyle = COLORS.agentShadowFill
  ctx.fill()
  ctx.restore()
}

function drawAgentGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isWaiting ? 0.3 : agent.state === 'thinking' ? 0.2 : 0.1
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * 0.5), Math.ceil(glowR), alphaHex(glowAlpha))
  ctx.drawImage(sprite, agent.x - Math.ceil(glowR), agent.y - Math.ceil(glowR))

  // Ambient outer hex ring
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = color + '25'
  ctx.lineWidth = 1
  ctx.stroke()

  // Inner hex fill
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()
}

function drawScanline(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean, time: number) {
  const scanSpeed = agent.state === 'thinking' || isWaiting ? ANIM.scanline.thinking : ANIM.scanline.normal
  const scanY = agent.y - r + ((time * scanSpeed) % (r * 2))
  ctx.save()
  drawHexagon(ctx, agent.x, agent.y, r)
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
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  if (isWaiting) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

function drawCenterIcon(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean) {
  if (isWaiting) {
    // Geometric lock icon — fits the holographic style
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = color + '90'
    ctx.fillStyle = color + '90'
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
  } else if (agent.isMain) {
    drawClaudeSpark(ctx, agent.x, agent.y, r, color + '90')
  } else {
    ctx.fillStyle = color + '90'
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(agent.state === 'tool_calling' ? '\u2699' : '\u25C7', agent.x, agent.y)
  }
}

/** Pulse for an active agent (thinking or waiting for permission): two staggered
 *  hexagon rings expand outward from the node and fade as they grow. */
function drawPulseRipples(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  for (let i = 0; i < 2; i++) {
    const phase = (time * AGENT_DRAW.rippleSpeed + i * 0.5) % 1
    drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.rippleInnerOffset + phase * AGENT_DRAW.rippleMaxExpand)
    ctx.strokeStyle = color + alphaHex((1 - phase) * AGENT_DRAW.rippleMaxAlpha)
    ctx.lineWidth = 1.5 * (1 - phase)
    ctx.stroke()
  }
}

/** `awaiting`: the agents waiting on their sub-agents (see displayedState) */
export function drawAgents(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  awaiting: Set<string>,
  time: number,
) {
  for (const stored of agents.values()) {
    const state = displayedState(stored, awaiting)
    const agent = state === stored.state ? stored : { ...stored, state }
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const color = getStateColor(agent.state)

    const isWaiting = agent.state === 'waiting_permission'

    const breathe = isWaiting
      ? Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1
      : agent.state === 'thinking'
      ? Math.sin(time * ANIM.breathe.thinkingSpeed) * ANIM.breathe.thinkingAmp + 1
      : agent.state === 'idle' ? Math.sin(time * ANIM.breathe.idleSpeed) * ANIM.breathe.idleAmp + 1 : 1

    const r = radius * breathe * agent.scale

    ctx.save()
    ctx.globalAlpha = agent.opacity

    drawDepthShadow(ctx, agent, r)
    drawAgentGlow(ctx, agent, r, color, isWaiting)
    drawScanline(ctx, agent, r, color, isWaiting, time)
    drawStateRing(ctx, agent, r, color, isWaiting, time)
    drawCenterIcon(ctx, agent, r, color, isWaiting)

    if (agent.state === 'thinking' || isWaiting) {
      drawPulseRipples(ctx, agent, r, color, time)
    }

    ctx.restore()
  }
}
