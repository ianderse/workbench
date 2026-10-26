import { Agent, ToolCallNode, Edge, BEAM } from '../../lib/agent-types'
import { getStateColor, getToolColor } from '../../lib/colors'
import { alphaHex } from '../../lib/utils'
import { MIN_VISIBLE_OPACITY } from '../../lib/canvas-constants'
import { drawJellyShape, restingMotion, type NodeMotion } from '../../lib/jelly'
import { displayedState } from '../../hooks/graph/types'

const DASH = [...BEAM.dash]
const DASH_PERIOD = DASH.reduce((a, b) => a + b, 0)

/** Each edge's dash offset, accumulated frame by frame (see drawEdges) */
const dashOffsets = new WeakMap<Edge, number>()

type Point = { x: number; y: number }

function bezierAt(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const mt = 1 - t
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y }
}

/** Control points of the part of a cubic bezier between t0 and t1 */
function bezierSegment(t0: number, t1: number, p0: Point, p1: Point, p2: Point, p3: Point): [Point, Point, Point, Point] {
  const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  // Split at t1 and keep the first part…
  const a1 = lerp(p0, p1, t1), b1 = lerp(p1, p2, t1), c1 = lerp(p2, p3, t1)
  const a2 = lerp(a1, b1, t1), b2 = lerp(b1, c1, t1)
  const end = lerp(a2, b2, t1)
  const q0 = p0, q1 = a1, q2 = a2, q3 = end
  // …then split that at t0 (rescaled; t1 is at least 0.5, see exitParam) and keep the second part
  const s = t0 / t1
  const d1 = lerp(q0, q1, s), e1 = lerp(q1, q2, s), f1 = lerp(q2, q3, s)
  const d2 = lerp(d1, e1, s), e2 = lerp(e1, f1, s)
  return [lerp(d2, e2, s), e2, f1, q3]
}

/** The curve parameter where it leaves a circle of radius r around one of its
 *  ends (`fromEnd`: around p3, searching back from t = 1) */
function exitParam(r: number, fromEnd: boolean, p0: Point, p1: Point, p2: Point, p3: Point): number {
  const center = fromEnd ? p3 : p0
  const isInside = (t: number) => {
    const p = bezierAt(t, p0, p1, p2, p3)
    return Math.hypot(p.x - center.x, p.y - center.y) < r
  }
  let inside = fromEnd ? 1 : 0, outside = 0.5
  if (isInside(outside)) return outside // still inside halfway along: the nodes overlap
  for (let i = 0; i < 12; i++) {
    const mid = (inside + outside) / 2
    if (isInside(mid)) inside = mid
    else outside = mid
  }
  return outside
}

/** Radius an edge stops short of: the node's drawn size plus a small gap */
function nodeClearance(motion: NodeMotion): number {
  return motion.radius * motion.scale + BEAM.nodeGap
}

/** Bezier control points for an edge: a gentle curve to one side */
function computeControlPoints(fromX: number, fromY: number, toX: number, toY: number) {
  const dx = toX - fromX, dy = toY - fromY
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 1) return null
  const curvature = dist * BEAM.curvature
  const perpX = -dy / dist * curvature, perpY = dx / dist * curvature
  return {
    cp1x: fromX + dx * BEAM.cp1 + perpX, cp1y: fromY + dy * BEAM.cp1 + perpY,
    cp2x: fromX + dx * BEAM.cp2 + perpX, cp2y: fromY + dy * BEAM.cp2 + perpY,
  }
}

/** An edge as it is drawn this frame: the part of its curve between the two nodes, and how */
interface DrawnEdge {
  curve: [Point, Point, Point, Point]
  /** The box the curve, glow and all, stays inside */
  box: { left: number; top: number; right: number; bottom: number }
  color: string
  fade: number
  isTool: boolean
  offset: number
}

/** Stroke an edge, its strength scaled by `alpha`: a faint solid line with the dashes over it */
function strokeEdge(ctx: CanvasRenderingContext2D, edge: DrawnEdge, alpha: number) {
  const [s0, s1, s2, s3] = edge.curve
  // Fade in from both ends, so the edge emerges softly from each node
  const length = Math.hypot(s3.x - s0.x, s3.y - s0.y)
  const fadeFrac = Math.min(0.45, BEAM.endFade / Math.max(length, 1))
  const fading = (strength: number) => {
    const gradient = ctx.createLinearGradient(s0.x, s0.y, s3.x, s3.y)
    gradient.addColorStop(0, edge.color + '00')
    gradient.addColorStop(fadeFrac, edge.color + alphaHex(strength))
    gradient.addColorStop(1 - fadeFrac, edge.color + alphaHex(strength))
    gradient.addColorStop(1, edge.color + '00')
    return gradient
  }

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(s0.x, s0.y)
  ctx.bezierCurveTo(s1.x, s1.y, s2.x, s2.y, s3.x, s3.y)

  ctx.strokeStyle = fading(BEAM.glow.alpha * edge.fade * alpha)
  ctx.lineWidth = BEAM.glow.width
  ctx.stroke()

  ctx.setLineDash(DASH)
  ctx.lineDashOffset = edge.offset
  ctx.strokeStyle = fading(BEAM.alpha * edge.fade * alpha)
  ctx.lineWidth = edge.isTool ? BEAM.width.tool : BEAM.width.parentChild
  ctx.stroke()
  ctx.restore()
}

/**
 * Draw edges as dashed curves from an agent to its sub-agents and tool calls.
 * While the target is still working (a running tool, a sub-agent that hasn't
 * finished) the dashes flow toward it; once it has answered they flow back to
 * the agent until the target fades out. An edge always has the current color
 * of the node its dashes flow from. Agents waiting on their own sub-agents are
 * still working (`awaiting`, see displayedState). An edge runs between the
 * nodes where the jelly has them (`motions`, see node-motion.ts), so it keeps
 * hold of a node budding out of its parent or merging back into it.
 * `deltaTime` (seconds since the last frame) moves the dashes.
 *
 * Nodes are drawn over the edges but are see-through, so where a crowded graph
 * has an edge cross another node, that part is only faintly drawn
 * (BEAM.underNode): the node stays in front of it. What is faint is the node's
 * own outline as drawn this frame (`time`), and only as faint as the node is
 * shown: one fading in or out dims what it crosses as little as it is there.
 */
export function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: Edge[],
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  awaiting: Set<string>,
  motions: Map<string, NodeMotion>,
  deltaTime: number,
  time: number,
) {
  const drawn: DrawnEdge[] = []
  for (const edge of edges) {
    const from = agents.get(edge.from)
    if (!from || from.opacity < MIN_VISIBLE_OPACITY) continue
    const isTool = edge.type === 'tool'
    const target = isTool ? toolCalls.get(edge.to) : agents.get(edge.to)
    if (!target || target.opacity < MIN_VISIBLE_OPACITY) continue

    const fromMotion = motions.get(edge.from) ?? restingMotion(from.x, from.y)
    const toMotion = motions.get(edge.to) ?? restingMotion(target.x, target.y)

    const cp = computeControlPoints(fromMotion.x, fromMotion.y, toMotion.x, toMotion.y)
    if (!cp) continue

    // Only the part between the two nodes: it starts and ends at their borders
    const p0 = { x: fromMotion.x, y: fromMotion.y }, p1 = { x: cp.cp1x, y: cp.cp1y }
    const p2 = { x: cp.cp2x, y: cp.cp2y }, p3 = { x: toMotion.x, y: toMotion.y }
    const t0 = exitParam(nodeClearance(fromMotion), false, p0, p1, p2, p3)
    const t1 = exitParam(nodeClearance(toMotion), true, p0, p1, p2, p3)
    if (t1 <= t0) continue // the nodes overlap: nothing in between to draw

    const working = isTool
      ? (target as ToolCallNode).state === 'running'
      : displayedState(target as Agent, awaiting) !== 'complete'
    // The node the dashes flow from: the caller while it waits, the target once it answers
    const color = working
      ? getStateColor(displayedState(from, awaiting))
      : isTool ? getToolColor((target as ToolCallNode).state) : getStateColor(displayedState(target as Agent, awaiting))

    // The path runs from caller to target: a falling dash offset moves the
    // dashes toward the target, a rising one moves them back. It carries on
    // from the last frame, so the dashes don't jump when the direction flips.
    const offset = ((dashOffsets.get(edge) ?? 0) + (working ? -1 : 1) * deltaTime * BEAM.flowSpeed) % DASH_PERIOD
    dashOffsets.set(edge, offset)

    const curve = bezierSegment(t0, t1, p0, p1, p2, p3)
    const xs = curve.map((p) => p.x), ys = curve.map((p) => p.y)
    const pad = BEAM.glow.width
    drawn.push({
      curve,
      box: { left: Math.min(...xs) - pad, top: Math.min(...ys) - pad, right: Math.max(...xs) + pad, bottom: Math.max(...ys) + pad },
      color,
      fade: Math.min(from.opacity, target.opacity),
      isTool,
      offset,
    })
  }
  if (drawn.length === 0) return

  // The nodes an edge can pass under: every one shown, with how far out its
  // outline can reach (see coverReach)
  const covers: Cover[] = []
  for (const [id, motion] of motions) {
    const node = agents.get(id) ?? toolCalls.get(id)
    if (!node || node.opacity < MIN_VISIBLE_OPACITY) continue
    covers.push({ motion, r: motion.radius * motion.scale, reach: coverReach(motion), opacity: Math.min(node.opacity, 1) })
  }
  const outline = (cover: Cover) =>
    drawJellyShape(ctx, cover.motion.x, cover.motion.y, cover.r, cover.motion.sides, cover.motion.rotation, cover.motion, time)
  // Everything but the node: what is left once it is cut out of a square far past the screen
  const clipOutside = (cover: Cover) => {
    outline(cover)
    ctx.rect(cover.motion.x - OUTSIDE, cover.motion.y - OUTSIDE, OUTSIDE * 2, OUTSIDE * 2)
    ctx.clip('evenodd')
  }
  const near = (a: Cover, box: DrawnEdge['box']) =>
    a.motion.x + a.reach > box.left && a.motion.x - a.reach < box.right
    && a.motion.y + a.reach > box.top && a.motion.y - a.reach < box.bottom
  const overlap = (a: Cover, b: Cover) => Math.hypot(a.motion.x - b.motion.x, a.motion.y - b.motion.y) < a.reach + b.reach

  // Outside every node: each clip takes one more node out of what is left
  ctx.save()
  for (const cover of covers) clipOutside(cover)
  for (const edge of drawn) strokeEdge(ctx, edge, 1)
  ctx.restore()

  // Under each node in turn (but not again under one done before it, where two
  // overlap): the edges that come near it, as faint as it is shown
  covers.forEach((cover, index) => {
    const under = drawn.filter((edge) => near(cover, edge.box))
    if (under.length === 0) return
    ctx.save()
    outline(cover)
    ctx.clip()
    for (let j = 0; j < index; j++) if (overlap(covers[j], cover)) clipOutside(covers[j])
    const strength = 1 - cover.opacity * (1 - BEAM.underNode)
    for (const edge of under) strokeEdge(ctx, edge, strength)
    ctx.restore()
  })
}

/** A node an edge can pass under (see drawEdges) */
interface Cover {
  motion: NodeMotion
  /** Its radius as drawn, and how far from its center its outline can reach */
  r: number
  reach: number
  opacity: number
}

/** How far past its radius a node's outline can bulge, at most (its wobble and dents) */
const COVER_REACH = 1.3

/** How far from its center a node's outline can reach this frame: its bulges,
 *  the goo necks it draws out toward the nodes it is gooed to (each `length`
 *  radii, see JellyReach), and as far as it is stretched */
export function coverReach(motion: NodeMotion): number {
  let necks = 0
  for (const reach of motion.reaches) necks += reach.length
  return motion.radius * motion.scale * (COVER_REACH + necks) * (1 + Math.abs(motion.stretch))
}

/** Half the side of the square a node is cut out of: far past anything on screen */
const OUTSIDE = 1e6
