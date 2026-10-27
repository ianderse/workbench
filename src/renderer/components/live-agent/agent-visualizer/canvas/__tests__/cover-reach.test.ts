import { describe, it, expect } from 'vitest'
import { coverReach } from '../draw-edges'
import { createJellyField, updateJelly } from '../node-motion'
import { drawJellyShape, type NodeMotion } from '../../../lib/jelly'
import type { Agent, ToolCallNode } from '../../../lib/agent-types'

/** How far from its center a node's outline is drawn this frame, at most */
function drawnReach(motion: NodeMotion, time: number): number {
  let furthest = 0
  const at = (x: number, y: number) => { furthest = Math.max(furthest, Math.hypot(x - motion.x, y - motion.y)) }
  const ctx = { beginPath() {}, closePath() {}, moveTo: at, lineTo: at } as unknown as CanvasRenderingContext2D
  drawJellyShape(ctx, motion.x, motion.y, motion.radius * motion.scale, motion.sides, motion.rotation, motion, time)
  return furthest
}

describe('coverReach', () => {
  it('reaches as far as the goo neck of a tool call budding off its agent', () => {
    const main = { id: 'main', state: 'tool_calling', parentId: null, x: 0, y: 0, isMain: true, opacity: 1 } as Agent
    const field = createJellyField()
    const agents = new Map([['main', main]])
    updateJelly(field, agents, new Map(), new Set(), 0, 0)

    for (let opacity = 0.3; opacity <= 1; opacity += 0.05) {
      const read: ToolCallNode = { agentId: 'main', toolName: 'Read', state: 'running', x: 110, y: 0, startTime: 0, opacity }
      const motions = updateJelly(field, agents, new Map([['read', read]]), new Set(), 1, 1 / 60)
      for (const motion of motions.values()) expect(coverReach(motion)).toBeGreaterThanOrEqual(drawnReach(motion, 1))
      // Gooed together, the two are always found to overlap (see drawEdges)
      const a = motions.get('main')!, b = motions.get('read')!
      if (b.attached.length > 0) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(coverReach(a) + coverReach(b))
      }
    }
  })
})
