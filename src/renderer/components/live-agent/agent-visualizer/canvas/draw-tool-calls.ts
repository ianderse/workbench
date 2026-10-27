import { ToolCallNode } from '../../lib/agent-types'
import { COLORS, getToolColor } from '../../lib/colors'
import { TOOL_DRAW } from '../../lib/canvas-constants'
import { alphaHex } from '../../lib/utils'
import { drawJellyShape, type NodeMotion } from '../../lib/jelly'
import { clipOutsideAttached } from './node-motion'

const NAME_FONT = `${TOOL_DRAW.fontWeight} ${TOOL_DRAW.fontSize}px monospace`

/** Draw each tool call as a circle showing the tool name, sized to fit it.
 *  `motions`: where the jelly has each node this frame (see node-motion.ts) */
export function drawToolCalls(
  ctx: CanvasRenderingContext2D,
  toolCalls: Map<string, ToolCallNode>,
  motions: Map<string, NodeMotion>,
  time: number,
) {
  for (const [id, tool] of toolCalls) {
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    // Drawn where the jelly has it: out of its agent as it buds off, back in as it merges
    const motion = motions.get(id)
    if (!motion) continue
    const r = motion.radius * motion.scale

    ctx.save()
    ctx.globalAlpha = tool.opacity
    // Where it is gooed to its agent the two borders are one shape: keep what
    // it draws out of the agent's
    clipOutsideAttached(ctx, motion, motions, time)

    // Error glow
    if (isError) {
      ctx.shadowColor = COLORS.error
      ctx.shadowBlur = TOOL_DRAW.errorGlowBase + Math.sin(time * 6) * TOOL_DRAW.errorGlowPulse
    }

    drawJellyShape(ctx, motion.x, motion.y, r, 0, 0, motion, time)
    ctx.strokeStyle = getToolColor(tool.state)
    ctx.lineWidth = TOOL_DRAW.borderWidth
    ctx.stroke()

    ctx.shadowBlur = 0

    // Pulse while running: rings expanding outward from the edge, fading as
    // they grow. Each ring is the node's own border again, further out: the
    // same jelly, so a ring is the shape it came off rather than a circle
    if (isRunning) {
      for (let i = 0; i < 2; i++) {
        const phase = (time * TOOL_DRAW.rippleSpeed + i * 0.5) % 1
        const ringR = r + TOOL_DRAW.rippleInnerOffset + phase * TOOL_DRAW.rippleMaxExpand
        drawJellyShape(ctx, motion.x, motion.y, ringR, 0, 0, motion, time)
        ctx.strokeStyle = getToolColor(tool.state) + alphaHex((1 - phase) * TOOL_DRAW.rippleMaxAlpha)
        ctx.lineWidth = 1.5 * (1 - phase)
        ctx.stroke()
      }
    }

    // The name rides along with the node, but isn't squashed with it
    ctx.translate(motion.x, motion.y)
    ctx.scale(motion.scale, motion.scale)
    ctx.font = NAME_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = getToolColor(tool.state)
    ctx.fillText(tool.toolName, 0, 0)

    ctx.restore()
  }
}
