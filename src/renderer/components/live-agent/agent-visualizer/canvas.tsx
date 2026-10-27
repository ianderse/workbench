import { useRef, useEffect, useState, useCallback } from 'react'
import { type GraphState, agentsAwaitingSubagents, displayedState } from '../hooks/graph/types'
import { getStateColor } from '../lib/colors'
import { ANIM_SPEED } from '../lib/canvas-constants'
import { BLOOM_INTENSITY, BloomRenderer } from './bloom-renderer'
import { drawBackground } from './background-layer'
import {
  type VisualEffect,
  drawEffects,
  drawAgents,
  drawEdges,
  drawToolCalls,
  detectStateChanges as detectStateChangesPure,
  createJellyField, resetJellyField, updateJelly,
} from './canvas/index'
import { useCanvasCamera } from '../hooks/use-canvas-camera'
import type { FaceState } from './canvas/draw-face'

/** The bloom for the app's current light/dark mode (the `dark` class on <html>) */
function themeBloom(): number {
  return document.documentElement.classList.contains('dark') ? BLOOM_INTENSITY.dark : BLOOM_INTENSITY.light
}

interface CanvasProps {
  /** Ref to the graph state — read every frame without React re-renders */
  graphRef: React.RefObject<GraphState>
  /** Changes whenever the graph is swapped or rebuilt (session switch, replaced
   *  history): the previous graph's effects are dropped, new ones are held back
   *  for a moment, and the camera is placed afresh */
  viewKey: string
  /** The session the graph is showing. The faces outlive a rebuild of the same
   *  one: how long the main agent has been left alone is the window's business,
   *  not this snapshot of the graph's, and clearing it started its resting
   *  cycle over every time a session's history was replaced */
  sessionKey: string
  /** Set while events queued at a swap or rebuild (its history, or what a
   *  restored graph missed) wait to be applied */
  historyQueuedRef: React.RefObject<boolean>
  /** The window is still starting, so the graph sits behind its spinner: the
   *  main agent holds its resting cycle until it is shown (see drawFace) */
  suspended?: boolean
}

export function AgentCanvas({ graphRef, viewKey, sessionKey, historyQueuedRef, suspended = false }: CanvasProps) {
  // Read in the draw loop, which runs outside React's renders
  const suspendedRef = useRef(suspended)
  suspendedRef.current = suspended
  const containerRef = useRef<HTMLDivElement>(null)
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const animationRef = useRef<number>(0)
  const timeRef = useRef(0)
  const bloomRef = useRef<BloomRenderer | null>(null)
  /** The canvas was sized once (a new canvas may already be the right size) */
  const sizedRef = useRef(false)
  const lastFrameTimeRef = useRef(0)
  const viewKeyRef = useRef(viewKey)
  viewKeyRef.current = viewKey
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey
  const drawnViewKeyRef = useRef(viewKey)
  /** Effects are held back until the new graph has its queued events */
  const quietRef = useRef(false)
  const drawnSessionKeyRef = useRef<string | null>(null)

  /** The main agent's face animation (eyes, blinks), kept between frames */
  const facesRef = useRef<Map<string, FaceState>>(new Map())

  /** The nodes' jelly: where each one is on its way out of or back into its
   *  parent, and the dents they are ringing from (see canvas/node-motion.ts) */
  const jellyRef = useRef(createJellyField())

  // Effects system
  const effectsRef = useRef<VisualEffect[]>([])
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())

  // Rate-limited error logging for the draw loop (avoid flooding console)
  const lastDrawErrorRef = useRef(0)

  // ─── Stable refs for the animation loop ─────────────────────────────────
  // Graph data (agents, tool calls, edges) is synced from graphRef
  // at the top of each draw frame, so it's always fresh even without re-renders.
  const graph = graphRef.current
  const makeDrawProps = () => ({
    agents: graph.agents, toolCalls: graph.toolCalls,
    edges: graph.edges,
    dimensions,
  })
  const drawPropsRef = useRef(makeDrawProps())
  drawPropsRef.current = makeDrawProps()

  // ─── Camera ─────────────────────────────────────────────────────────────
  const {
    transformRef, updateCamera, resetPlacement,
  } = useCanvasCamera({ drawPropsRef })

  // ─── Setup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const bloom = new BloomRenderer(themeBloom())
    // Sized now if the canvas already is (e.g. this effect re-ran after a hot
    // reload): the draw loop resizes it only on its first frame and when the
    // canvas size changes
    const canvas = mainCanvasRef.current
    if (canvas) bloom.resize(canvas.width, canvas.height)
    bloomRef.current = bloom

    // The nodes keep their own colors in either mode; only the bloom comes
    // down over a light window. The draw loop picks it up on its next frame.
    const observer = new MutationObserver(() => bloom.setIntensity(themeBloom()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
      bloomRef.current = null
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Detect state changes → spawn effects ──────────────────────────────

  const detectStateChanges = useCallback((awaiting: Set<string>) => {
    const { agents, toolCalls } = drawPropsRef.current
    const { effects, newAgentStates, newToolStates } = detectStateChangesPure(
      agents, toolCalls, awaiting,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    // After the graph is swapped or rebuilt (see draw), only record its states:
    // its nodes didn't just change. That includes the events queued with it,
    // all applied in one frame: stay quiet until that frame.
    if (quietRef.current) {
      if (!historyQueuedRef.current) quietRef.current = false
    } else {
      effectsRef.current.push(...effects)
    }
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates
  }, [historyQueuedRef])

  // ─── Main draw loop ────────────────────────────────────────────────────

  // Stable ref so the rAF loop always calls the latest draw without
  // re-subscribing when the callback identity changes.
  const drawRef = useRef<(timestamp: number) => void>(() => {})

  const draw = useCallback((timestamp: number) => {
    animationRef.current = requestAnimationFrame((ts) => drawRef.current(ts))

    const canvas = mainCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    try {
      // Sync graph data from ref — always fresh, independent of React renders
      {
        const s = graphRef.current
        const p = drawPropsRef.current
        p.agents = s.agents
        p.toolCalls = s.toolCalls
        p.edges = s.edges
      }

      const {
        agents, toolCalls, edges,
        dimensions,
      } = drawPropsRef.current

      // Capped so a long pause (e.g. a background tab) doesn't jump the animation
      const deltaTime = lastFrameTimeRef.current
        ? Math.min((timestamp - lastFrameTimeRef.current) / 1000, ANIM_SPEED.maxDeltaTime)
        : ANIM_SPEED.defaultDeltaTime
      lastFrameTimeRef.current = timestamp
      timeRef.current += deltaTime

      // Read every frame: it changes when the window moves to another screen or is zoomed
      const dpr = window.devicePixelRatio || 1
      const w = dimensions.width
      const h = dimensions.height

      const pixelW = Math.round(w * dpr)
      const pixelH = Math.round(h * dpr)
      // (also on the first frame: a new canvas may already be the right size)
      if (canvas.width !== pixelW || canvas.height !== pixelH || !sizedRef.current) {
        canvas.width = pixelW
        canvas.height = pixelH
        bloomRef.current?.resize(pixelW, pixelH)
        sizedRef.current = true
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // A swapped or rebuilt graph: drop the previous one's effects, hold new
      // ones back for a moment (see detectStateChanges), and place the camera afresh
      if (drawnViewKeyRef.current !== viewKeyRef.current) {
        drawnViewKeyRef.current = viewKeyRef.current
        effectsRef.current.length = 0
        if (drawnSessionKeyRef.current !== sessionKeyRef.current) {
          drawnSessionKeyRef.current = sessionKeyRef.current
          facesRef.current.clear()
        }
        resetJellyField(jellyRef.current)
        quietRef.current = true
        resetPlacement()
      }

      // Camera auto-fit (this frame is drawn with the updated camera)
      updateCamera(deltaTime)
      const transform = transformRef.current

      // Agents waiting on their sub-agents are shown busy (see displayedState)
      const awaiting = agentsAwaitingSubagents(agents)

      // Detect state changes → visual effects
      // Taken before the quiet period is cleared below: the frame that applies
      // a rebuilt graph's history is itself a replay, and the faces have to sit
      // it out rather than read it as the agents doing all of that now
      const replaying = quietRef.current
      detectStateChanges(awaiting)

      // Advance the jelly: where every node is drawn this frame
      const motions = updateJelly(jellyRef.current, agents, toolCalls, awaiting, timeRef.current, deltaTime)

      // Update effects (mutate in place to avoid GC pressure)
      {
        const effects = effectsRef.current
        let writeIdx = 0
        for (let i = 0; i < effects.length; i++) {
          effects[i].age += deltaTime
          if (effects[i].age < effects[i].duration) {
            if (writeIdx !== i) effects[writeIdx] = effects[i]
            writeIdx++
          }
        }
        effects.length = writeIdx
      }

      ctx.clearRect(0, 0, w, h)

      let activeAgentPos: { x: number; y: number; color: string } | undefined
      for (const [, agent] of agents) {
        const state = displayedState(agent, awaiting)
        if (state === 'thinking' || state === 'tool_calling' || state === 'waiting_permission') {
          activeAgentPos = { x: agent.x, y: agent.y, color: getStateColor(state) }
          break
        }
      }

      drawBackground(ctx, w, h, transform, activeAgentPos)

      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.scale, transform.scale)

      drawEdges(ctx, edges, agents, toolCalls, awaiting, motions, deltaTime, timeRef.current)
      drawToolCalls(ctx, toolCalls, motions, timeRef.current)
      drawAgents(ctx, agents, awaiting, toolCalls, facesRef.current, motions, timeRef.current, suspendedRef.current, replaying)
      drawEffects(ctx, effectsRef.current)

      ctx.restore()

      if (bloomRef.current) bloomRef.current.apply(canvas, ctx)
    } catch (err) {
      // Log at most once every 5s to avoid flooding the console
      const now = Date.now()
      if (now - lastDrawErrorRef.current > 5000) {
        lastDrawErrorRef.current = now
        console.warn('[AgentCanvas] draw error:', err)
      }
    }
  }, [detectStateChanges, updateCamera, resetPlacement, transformRef])

  drawRef.current = draw

  useEffect(() => {
    const loop = (timestamp: number) => drawRef.current(timestamp)
    animationRef.current = requestAnimationFrame(loop)
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  // drawRef is stable; the rAF loop is set up once
  }, [])

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      <canvas
        ref={mainCanvasRef}
        style={{ width: dimensions.width, height: dimensions.height }}
      />
    </div>
  )
}
