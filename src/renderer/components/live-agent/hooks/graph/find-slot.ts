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
 * just the parent's own, since branches grow into each other's space.
 */
export function findFreeSlot({ parent, radius, footprint, preferredAngle, agents, toolCalls }: SlotRequest): { x: number; y: number } {
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

  /** How many nodes the new one would overlap at (x, y), counting no further than `limit` */
  const clashes = (x: number, y: number, limit: number): number => {
    let hits = 0
    for (let i = 0; i < n; i++) {
      const dx = x - xs[i], dy = y - ys[i]
      if (dx * dx + dy * dy < minDistSq[i] && ++hits >= limit) break
    }
    return hits
  }

  // The first ring sits where the edge to the parent is as long as the parent is wide
  const nearest = nodeDistance(parent.radius, radius)
  let best: { x: number; y: number } | undefined
  let bestClashes = Infinity

  for (let ring = 1; ring <= NODE_SLOT.maxRings; ring++) {
    const dist = nearest + (ring - 1) * NODE_SLOT.ringIncrement
    // Sample the ring about every node-width, so nothing slips between two tries
    const steps = Math.min(
      NODE_SLOT.maxSteps,
      Math.max(NODE_SLOT.minSteps, Math.round((Math.PI * 2 * dist) / (room * 2 + NODE_SLOT.gap)))
    )
    for (const angle of sweepAngles(preferredAngle, steps)) {
      const x = parent.x + Math.cos(angle) * dist
      const y = parent.y + Math.sin(angle) * dist
      const hits = clashes(x, y, bestClashes)
      if (hits === 0) return { x, y }
      // A graph crowded to the last ring takes the emptiest spot anywhere
      if (hits < bestClashes) { bestClashes = hits; best = { x, y } }
    }
  }

  return best ?? { x: parent.x + Math.cos(preferredAngle) * nearest, y: parent.y + Math.sin(preferredAngle) * nearest }
}
