import { NODE, ANIM, type Agent, type AgentState, type ToolCallNode } from '../../lib/agent-types'
import { AGENT_DRAW, estimateToolNodeRadius } from '../../lib/canvas-constants'
import {
  JELLY, jellySeed, shapeInradius, pathNodeShape,
  type JellyPoke, type JellyReach, type NodeMotion,
} from '../../lib/jelly'
import { displayedState } from '../../hooks/graph/types'

/** A node as it was last frame: enough to spot a new one, and to tell where one
 *  that has gone was when it reached its parent */
interface KnownNode {
  parentId: string | null
  x: number
  y: number
  seed: number
}

/** A node's motion, with the parts only this module writes */
interface MutableMotion extends NodeMotion {
  pokes: readonly JellyPoke[]
  reaches: JellyReach[]
  attached: string[]
}

/** What the jelly needs between frames */
export interface JellyField {
  /** The dents each node is still ringing from */
  pokes: Map<string, JellyPoke[]>
  known: Map<string, KnownNode>
  /** This frame's motions, reused so the draw loop allocates nothing */
  motions: Map<string, MutableMotion>
  /** Set after a reset: the next frame's nodes are only taken in, not reacted to */
  quiet: boolean
}

export function createJellyField(): JellyField {
  return { pokes: new Map(), known: new Map(), motions: new Map(), quiet: true }
}

/** Forget everything (the graph was swapped or rebuilt: its nodes aren't new) */
export function resetJellyField(field: JellyField) {
  field.pokes.clear()
  field.known.clear()
  field.motions.clear()
  field.quiet = true
}

/** The main agent is a pentagon, sub-agents hexagons, a background session a square */
const sidesOf = (agent: Agent) => (agent.isMain ? 5 : agent.isSatellite ? 4 : 6)

/** Half a square's corner angle, which stands it on its side instead of on a vertex */
const rotationOf = (agent: Agent) => (agent.isSatellite && !agent.isMain ? Math.PI / 4 : 0)

/** The node breathing: deeper while it waits for permission or thinks, barely while it rests */
function breatheOf(state: AgentState, time: number): number {
  if (state === 'waiting_permission') {
    return Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1
  }
  if (state === 'thinking') return Math.sin(time * ANIM.breathe.thinkingSpeed) * ANIM.breathe.thinkingAmp + 1
  if (state === 'idle') return Math.sin(time * ANIM.breathe.idleSpeed) * ANIM.breathe.idleAmp + 1
  return 1
}

function agePokes(field: JellyField, deltaTime: number) {
  for (const [id, pokes] of field.pokes) {
    let writeIdx = 0
    for (let i = 0; i < pokes.length; i++) {
      pokes[i].age += deltaTime
      if (pokes[i].age < JELLY.poke.duration) {
        if (writeIdx !== i) pokes[writeIdx] = pokes[i]
        writeIdx++
      }
    }
    pokes.length = writeIdx
    if (writeIdx === 0) field.pokes.delete(id)
  }
}

/** Dent the parent on the side (x, y) lies on */
function poke(field: JellyField, parent: Agent, x: number, y: number, strength: number) {
  const dx = x - parent.x, dy = y - parent.y
  const len = Math.hypot(dx, dy) || 1
  let pokes = field.pokes.get(parent.id)
  if (!pokes) { pokes = []; field.pokes.set(parent.id, pokes) }
  pokes.push({ dirX: dx / len, dirY: dy / len, strength, age: 0 })
}

/** Take in this frame's nodes: a new one dents the parent it was pushed out of,
 *  one that has gone dents the parent it merged into */
function syncKnown(field: JellyField, agents: Map<string, Agent>, toolCalls: Map<string, ToolCallNode>) {
  const gone = new Set(field.known.keys())

  const take = (id: string, parentId: string | null, x: number, y: number) => {
    gone.delete(id)
    const existing = field.known.get(id)
    if (existing) {
      existing.parentId = parentId
      existing.x = x
      existing.y = y
      return
    }
    field.known.set(id, { parentId, x, y, seed: jellySeed(id) })
    const parent = parentId ? agents.get(parentId) : undefined
    if (parent && !field.quiet) poke(field, parent, x, y, JELLY.poke.birth)
  }

  for (const [id, agent] of agents) take(id, agent.parentId, agent.x, agent.y)
  for (const [id, tool] of toolCalls) take(id, tool.agentId, tool.x, tool.y)

  for (const id of gone) {
    const node = field.known.get(id)!
    field.known.delete(id)
    field.motions.delete(id)
    const parent = node.parentId ? agents.get(node.parentId) : undefined
    if (parent && !field.quiet) poke(field, parent, node.x, node.y, JELLY.poke.arrival)
  }

  field.quiet = false
}

/**
 * The node's place this frame, from `away`: how far out of its parent it is, 0
 * merged on the parent's border and 1 in its own place. Its fade is what moves
 * it, so a node coming out and a node going back run the same way (see
 * JELLY.merge).
 */
function writeMotion(
  field: JellyField, id: string, x: number, y: number, radius: number, sides: number, rotation: number,
  parent: NodeMotion | undefined, breathe: number, away: number,
) {
  let axisX = 0, axisY = 1
  let rimX = x, rimY = y
  if (parent) {
    const dx = x - parent.x, dy = y - parent.y
    const len = Math.hypot(dx, dy)
    if (len > 1) {
      axisX = dx / len
      axisY = dy / len
      // It leaves the parent, and comes back to it, on the parent's border
      const rim = shapeInradius(parent.radius * parent.scale, parent.sides) * JELLY.merge.rimAt
      rimX = parent.x + axisX * rim
      rimY = parent.y + axisY * rim
    }
  }

  const out = away ** JELLY.merge.ease
  const mx = rimX + (x - rimX) * out
  const my = rimY + (y - rimY) * out
  const scale = JELLY.merge.rimScale + (1 - JELLY.merge.rimScale) * away
  const stretch = JELLY.merge.rimStretch * (1 - away)

  const pokes = field.pokes.get(id) ?? []
  const seed = field.known.get(id)?.seed ?? 0
  const motion = field.motions.get(id)
  if (motion) {
    motion.x = mx; motion.y = my
    motion.radius = radius
    motion.scale = scale * breathe
    motion.sides = sides
    motion.rotation = rotation
    motion.stretch = stretch
    motion.axisX = axisX; motion.axisY = axisY
    motion.seed = seed
    motion.pokes = pokes
    return motion
  }
  const created: MutableMotion = {
    x: mx, y: my, radius, scale: scale * breathe, sides, rotation,
    stretch, axisX, axisY, seed, pokes, reaches: [], attached: [],
  }
  field.motions.set(id, created)
  return created
}

/** Goo a node and its parent together while the gap between their borders is
 *  short: each border is drawn out past the halfway point, so the two overlap
 *  into one neck, which thins as the gap grows and snaps once it is too wide */
function linkGoo(childId: string, child: MutableMotion, parentId: string, parent: MutableMotion) {
  const dx = parent.x - child.x, dy = parent.y - child.y
  const dist = Math.hypot(dx, dy)
  if (dist < 0.001) return
  const childR = child.radius * child.scale
  const parentR = parent.radius * parent.scale
  const gap = dist - shapeInradius(childR, child.sides) - shapeInradius(parentR, parent.sides)
  if (gap >= JELLY.goo.reach) return

  const open = Math.max(0, gap)
  const half = open / 2 + JELLY.goo.margin
  const focus = JELLY.goo.focusNear + (JELLY.goo.focusFar - JELLY.goo.focusNear) * (open / JELLY.goo.reach)
  const reachOf = (r: number) => Math.min(JELLY.goo.maxLength, half / Math.max(r, 1))

  child.reaches.push({ dirX: dx / dist, dirY: dy / dist, length: reachOf(childR), focus })
  parent.reaches.push({ dirX: -dx / dist, dirY: -dy / dist, length: reachOf(parentR), focus })
  child.attached.push(parentId)
  parent.attached.push(childId)
}

/**
 * Advance the jelly and return where every node is drawn this frame. A node's
 * own fade carries it out of its parent and back into it (see writeMotion).
 * `time` is the canvas clock, which runs on whether or not the graph does.
 */
export function updateJelly(
  field: JellyField,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  awaiting: Set<string>,
  time: number,
  deltaTime: number,
): Map<string, NodeMotion> {
  agePokes(field, deltaTime)
  syncKnown(field, agents, toolCalls)

  // Place every node. Parents come first (they are spawned first), so a node
  // budding off one that is itself still moving comes out of where it is drawn.
  for (const [id, agent] of agents) {
    const parent = agent.parentId ? field.motions.get(agent.parentId) : undefined
    writeMotion(
      field, id, agent.x, agent.y,
      agent.isMain ? NODE.radiusMain : NODE.radiusSub, sidesOf(agent), rotationOf(agent),
      parent, breatheOf(displayedState(agent, awaiting), time), agent.opacity,
    )
  }
  for (const [id, tool] of toolCalls) {
    const parent = field.motions.get(tool.agentId)
    writeMotion(
      field, id, tool.x, tool.y, estimateToolNodeRadius(tool.toolName), 0, 0,
      parent, 1, tool.opacity,
    )
  }

  // Then the goo between each node and its parent
  for (const motion of field.motions.values()) {
    motion.reaches.length = 0
    motion.attached.length = 0
  }
  for (const [id, agent] of agents) {
    const parent = agent.parentId ? field.motions.get(agent.parentId) : undefined
    const motion = field.motions.get(id)
    if (parent && motion && agent.parentId) linkGoo(id, motion, agent.parentId, parent)
  }
  for (const [id, tool] of toolCalls) {
    const parent = field.motions.get(tool.agentId)
    const motion = field.motions.get(id)
    if (parent && motion) linkGoo(id, motion, tool.agentId, parent)
  }

  return field.motions
}

/** Keep what a node draws out of the nodes it is gooed to, so where they
 *  overlap the two borders read as the one shape the goo makes of them */
export function clipOutsideAttached(
  ctx: CanvasRenderingContext2D, motion: NodeMotion, motions: Map<string, NodeMotion>, time: number,
) {
  for (const id of motion.attached) {
    const other = motions.get(id)
    if (!other) continue
    pathNodeShape(ctx, other, time)
    // Everything but that shape: the path and a box around the whole graph, wound together
    ctx.rect(-1e5, -1e5, 2e5, 2e5)
    ctx.clip('evenodd')
  }
}
