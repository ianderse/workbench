import { useRef, useCallback, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, ANIM, NODE } from '../lib/agent-types'
import { CAMERA, AGENT_DRAW, TOOL_DRAW, estimateToolNodeRadius } from '../lib/canvas-constants'

/** World-space room kept around a node for its pulse rings */
const AGENT_PADDING = AGENT_DRAW.rippleInnerOffset + AGENT_DRAW.rippleMaxExpand
const TOOL_PADDING = TOOL_DRAW.rippleInnerOffset + TOOL_DRAW.rippleMaxExpand

interface Transform {
  x: number
  y: number
  scale: number
}

interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** Where the resting view is centered: the main agent, or the bounds center */
  anchorX: number
  anchorY: number
}

interface CameraOptions {
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    dimensions: { width: number; height: number }
  }>
}

/**
 * Auto-fit camera. At rest it shows the graph at CAMERA.restScale centered on
 * the main agent. When nodes would fall outside the page it pans, and zooms
 * out only as far as needed, to keep everything visible; once those nodes are
 * gone it eases back to the resting view. The camera is fully automatic.
 */
export function useCanvasCamera({ drawPropsRef }: CameraOptions) {
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 })
  /** Whether the camera has been placed on the current graph (it jumps to the
   *  first view instead of easing in from wherever it was) */
  const placedRef = useRef(false)

  // Cache for computeBounds — avoids O(n) iteration every frame.
  // Invalidates on collection reference change (the graph state gets new Maps when data changes).
  const boundsCacheRef = useRef<{
    agents: Map<string, Agent> | null
    toolCalls: Map<string, ToolCallNode> | null
    result: Bounds | null
  }>({ agents: null, toolCalls: null, result: null })

  /** World-space bounding box of all visible nodes (with room for their pulse rings) */
  const computeBounds = useCallback((): Bounds | null => {
    const { agents, toolCalls } = drawPropsRef.current
    const cache = boundsCacheRef.current
    if (cache.agents === agents && cache.toolCalls === toolCalls) return cache.result

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    let main: Agent | undefined
    const extend = (x: number, y: number, r: number) => {
      minX = Math.min(minX, x - r)
      maxX = Math.max(maxX, x + r)
      minY = Math.min(minY, y - r)
      maxY = Math.max(maxY, y + r)
    }
    for (const agent of agents.values()) {
      if (agent.isMain) main = agent
      extend(agent.x, agent.y, (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AGENT_PADDING)
    }
    for (const tool of toolCalls.values()) {
      if (tool.opacity > 0.1) {
        extend(tool.x, tool.y, estimateToolNodeRadius(tool.toolName) + TOOL_PADDING)
      }
    }

    const result = minX === Infinity ? null : {
      minX, maxX, minY, maxY,
      anchorX: main ? main.x : (minX + maxX) / 2,
      anchorY: main ? main.y : (minY + maxY) / 2,
    }
    boundsCacheRef.current = { agents, toolCalls, result }
    return result
  }, [drawPropsRef])

  /** Whether the bounds fit on screen under transform `t`, keeping CAMERA.viewMargin free */
  const fitsInView = useCallback((b: Bounds, t: Transform): boolean => {
    const { width, height } = drawPropsRef.current.dimensions
    const m = CAMERA.viewMargin
    return b.minX * t.scale + t.x >= m && b.maxX * t.scale + t.x <= width - m
      && b.minY * t.scale + t.y >= m && b.maxY * t.scale + t.y <= height - m
  }, [drawPropsRef])

  const computeFitTransform = useCallback((b: Bounds): Transform => {
    const { width, height } = drawPropsRef.current.dimensions
    const centeredOn = (cx: number, cy: number, scale: number): Transform =>
      ({ x: width / 2 - cx * scale, y: height / 2 - cy * scale, scale })

    // 1. Resting view: rest scale, centered on the main agent
    const rest = centeredOn(b.anchorX, b.anchorY, CAMERA.restScale)
    if (fitsInView(b, rest)) return rest

    // 2. Otherwise center on the content, zooming out only as far as needed
    const m = CAMERA.viewMargin
    const scale = Math.max(CAMERA.minZoom, Math.min(
      CAMERA.restScale,
      (width - 2 * m) / (b.maxX - b.minX),
      (height - 2 * m) / (b.maxY - b.minY),
    ))
    return centeredOn((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, scale)
  }, [drawPropsRef, fitsInView])

  /** Call from the draw loop: ease the camera toward the auto-fit view.
   *  `deltaTime` (seconds) keeps the easing speed independent of frame rate. */
  const updateCamera = useCallback((deltaTime: number) => {
    const bounds = computeBounds()
    if (!bounds) {
      placedRef.current = false // nothing to show: place the camera afresh on the next graph
      return
    }
    const target = computeFitTransform(bounds)
    if (!placedRef.current) {
      placedRef.current = true
      transformRef.current = target
      return
    }

    // ANIM.autoFitLerp is the fraction of the gap closed per 60fps frame
    const k = 1 - Math.pow(1 - ANIM.autoFitLerp, deltaTime * 60)
    const t = transformRef.current
    const nx = t.x + (target.x - t.x) * k
    const ny = t.y + (target.y - t.y) * k
    const ns = t.scale + (target.scale - t.scale) * k
    transformRef.current = Math.abs(target.x - nx) < 0.5 && Math.abs(target.y - ny) < 0.5 && Math.abs(target.scale - ns) < 0.001
      ? target
      : { x: nx, y: ny, scale: ns }
  }, [computeBounds, computeFitTransform])

  /** Place the camera afresh (snap, not ease) on the next graph drawn */
  const resetPlacement = useCallback(() => { placedRef.current = false }, [])

  return { transformRef, updateCamera, resetPlacement }
}
