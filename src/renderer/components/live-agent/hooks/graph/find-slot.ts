import { NODE, type Agent, type ToolCallNode } from '../../lib/agent-types'
import { AGENT_DRAW, NODE_SLOT, estimateToolNodeRadius, nodeDistance } from '../../lib/canvas-constants'

/** Room an agent node takes next to others: its radius plus its glow */
export const agentFootprint = (agent: Agent) =>
  (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AGENT_DRAW.glowPadding

export interface SlotRequest {
  /** Node the new one hangs off: it sits clear of it by construction, so it never counts as in the way */
  parent: { id: string; x: number; y: number; radius: number }
  /** Radius the node is drawn at, which sets how far out from the parent it sits */
  radius: number
  /** Room it needs next to other nodes (an agent's glow included); defaults to `radius` */
  footprint?: number
  /** Where it would sit if the graph were empty (its own direction out of the parent) */
  preferredAngle: number
  /**
   * The parent is only a point to grow from (a node with nothing to hang off starts in the
   * middle): try that point itself first
   */
  atParent?: boolean
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
}

/** Angles to try at a ring: the preferred one first, then either side of it */
function* sweepAngles(preferred: number, steps: number): Generator<number> {
  const step = (Math.PI * 2) / steps
  yield preferred
  for (let k = 1; k <= steps / 2; k++) {
    yield preferred + k * step
    yield preferred - k * step
  }
}

/**
 * Where to put a new node so it covers nothing else.
 *
 * Rings sweep outward from the parent, each ring tried from the preferred
 * direction outward to either side, so an uncrowded graph keeps growing the way
 * it always did and a crowded one spills around and further out instead of
 * stacking nodes on top of each other. Every agent and tool call counts, not
 * just the parent's own, since branches grow into each other's space. When
 * every ring near the parent is taken, the edge grows longer until the node
 * clears everything: nodes never overlap.
 */
export function findFreeSlot({ parent, radius, footprint, preferredAngle, agents, toolCalls, atParent }: SlotRequest): { x: number; y: number } {
  const room = footprint ?? radius

  // The nodes to stay clear of, flattened once: a spawn in a busy graph samples
  // hundreds of points, and each one would otherwise re-walk both maps
  const count = agents.size + toolCalls.size
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  /** Centre distance below which the new node would overlap that one, squared */
  const minDistSq = new Float64Array(count)
  let n = 0
  const add = (x: number, y: number, otherRoom: number) => {
    const limit = room + otherRoom + NODE_SLOT.gap
    xs[n] = x; ys[n] = y; minDistSq[n] = limit * limit
    n++
  }
  for (const agent of agents.values()) {
    if (agent.id === parent.id) continue
    add(agent.x, agent.y, agentFootprint(agent))
  }
  for (const tc of toolCalls.values()) add(tc.x, tc.y, estimateToolNodeRadius(tc.toolName))

  /** Whether the new node would overlap nothing at (x, y) */
  const clear = (x: number, y: number): boolean => {
    for (let i = 0; i < n; i++) {
      const dx = x - xs[i], dy = y - ys[i]
      if (dx * dx + dy * dy < minDistSq[i]) return false
    }
    return true
  }

  if (atParent && clear(parent.x, parent.y)) return { x: parent.x, y: parent.y }

  // Past this distance from the parent nothing is in the way in any direction
  let clearDist = 0
  for (let i = 0; i < n; i++) {
    clearDist = Math.max(clearDist, Math.hypot(xs[i] - parent.x, ys[i] - parent.y) + Math.sqrt(minDistSq[i]))
  }

  // The first ring sits where the edge to the parent is as long as the parent is wide
  const nearest = nodeDistance(parent.radius, radius)
  const at = (angle: number, dist: number) =>
    ({ x: parent.x + Math.cos(angle) * dist, y: parent.y + Math.sin(angle) * dist })

  for (let ring = 1; ; ring++) {
    // Rings close in are tried about every node-width; once those are all taken, the rings
    // spread further apart so a crowded graph reaches open space quickly
    const extra = Math.max(0, ring - NODE_SLOT.maxRings)
    const dist = nearest + (ring - 1 + extra * extra) * NODE_SLOT.ringIncrement
    if (dist >= clearDist) return at(preferredAngle, Math.max(dist, nearest))
    // Sample the ring about every node-width, so nothing slips between two tries
    const steps = Math.min(
      NODE_SLOT.maxSteps,
      Math.max(NODE_SLOT.minSteps, Math.round((Math.PI * 2 * dist) / (room * 2 + NODE_SLOT.gap)))
    )
    for (const angle of sweepAngles(preferredAngle, steps)) {
      const pos = at(angle, dist)
      if (clear(pos.x, pos.y)) return pos
    }
  }
}
