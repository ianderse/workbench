import { ToolCallNode } from '../../lib/agent-types'
import { COLORS, withAlpha, getToolColor } from '../../lib/colors'
import { TOOL_DRAW, toolNodeRadius } from '../../lib/canvas-constants'
import { alphaHex } from '../../lib/utils'
import { measureTextCached } from './render-cache'

const NAME_FONT = `${TOOL_DRAW.fontSize}px monospace`

/** Draw each tool call as a circle showing the tool name, sized to fit it */
export function drawToolCalls(
  ctx: CanvasRenderingContext2D,
  toolCalls: Map<string, ToolCallNode>,
  time: number,
) {
  for (const tool of toolCalls.values()) {
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    const pulse = isRunning ? Math.sin(time * 4) * 0.2 + 0.8 : isError ? Math.sin(time * 6) * 0.15 + 0.85 : 0.5

    ctx.save()
    ctx.globalAlpha = tool.opacity

    ctx.font = NAME_FONT
    const r = toolNodeRadius(measureTextCached(ctx, tool.toolName))

    // Error glow
    if (isError) {
      ctx.shadowColor = COLORS.error
      ctx.shadowBlur = TOOL_DRAW.errorGlowBase + Math.sin(time * 6) * TOOL_DRAW.errorGlowPulse
    }

    ctx.beginPath()
    ctx.arc(tool.x, tool.y, r, 0, Math.PI * 2)
    ctx.fillStyle = isError
      ? withAlpha(COLORS.toolNodeErrorBase, 0.8 * pulse)
      : withAlpha(COLORS.toolNodeBase, 0.7 * pulse)
    ctx.fill()
    ctx.strokeStyle = getToolColor(tool.state) + (isError ? '90' : isRunning ? '60' : '40')
    ctx.lineWidth = isError ? 2 : 1
    ctx.stroke()

    ctx.shadowBlur = 0

    // Pulse while running: rings expanding outward from the edge, fading as they grow
    if (isRunning) {
      for (let i = 0; i < 2; i++) {
        const phase = (time * TOOL_DRAW.rippleSpeed + i * 0.5) % 1
        ctx.beginPath()
        ctx.arc(tool.x, tool.y, r + TOOL_DRAW.rippleInnerOffset + phase * TOOL_DRAW.rippleMaxExpand, 0, Math.PI * 2)
        ctx.strokeStyle = getToolColor(tool.state) + alphaHex((1 - phase) * TOOL_DRAW.rippleMaxAlpha)
        ctx.lineWidth = 1.5 * (1 - phase)
        ctx.stroke()
      }
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = getToolColor(tool.state)
    ctx.fillText(tool.toolName, tool.x, tool.y)

    ctx.restore()
  }
}
