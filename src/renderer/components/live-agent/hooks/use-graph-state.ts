import { useState, useCallback, useRef, useEffect } from 'react'
import { NODE, type Agent, type ToolCallNode, type GraphEvent } from '../lib/agent-types'
import { MOCK_SCENARIO } from '../lib/mock-scenario'
import { TOOL_SLOT, ANIM_SPEED, AGENT_DRAW, estimateToolNodeRadius } from '../lib/canvas-constants'

import type { GraphState, UseGraphStateOptions } from './graph/types'
import { createEmptyState } from './graph/types'
import { processEvent, type ProcessEventContext } from './graph/process-event'
import { computeNextFrame } from './graph/animate'

/** Room an agent node takes for tool placement: its radius plus its glow */
const agentFootprint = (agent: Agent) =>
  (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AGENT_DRAW.glowPadding

export function useGraphState(options: UseGraphStateOptions) {
  const { useMockData, externalEvents, onExternalEventsConsumed } = options

  // ─── State management ──────────────────────────────────────────────────────
  // graphRef: source of truth, updated every animation frame (no React render);
  // the canvas reads it directly for 60fps rendering. React only tracks the two
  // facts the UI needs: whether the loop is running (set the moment it changes)
  // and whether there is anything to show (synced by the next frame).
  const graphRef = useRef<GraphState>(createEmptyState())
  const [isPlaying, setIsPlaying] = useState(false)
  const [hasAgents, setHasAgents] = useState(false)
  const hasAgentsRef = useRef(false)

  const syncReactState = useCallback((graph: GraphState) => {
    setIsPlaying(graph.isPlaying)
    hasAgentsRef.current = graph.agents.size > 0
    setHasAgents(hasAgentsRef.current)
  }, [])

  /** Replace the graph state. Whether it has anything to show is left to the
   *  next frame: a rebuilt graph starts empty and gets its history then, and
   *  the empty-state overlay would flash in between. */
  const commitState = useCallback((next: GraphState) => {
    graphRef.current = next
    setIsPlaying(next.isPlaying)
  }, [])

  const animationRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const animateRef = useRef<(timestamp: number) => void>(() => {})

  // ─── Tool slot placement ─────────────────────────────────────────────────
  const findToolSlot = useCallback((
    agent: Agent, agents: Map<string, Agent>,
    toolCalls: Map<string, ToolCallNode>, toolName: string,
  ): { x: number; y: number } => {
    const radius = estimateToolNodeRadius(toolName)
    /** How many tools and agents a circle at (cx, cy) would overlap */
    const clashes = (cx: number, cy: number) => {
      let count = 0
      for (const tc of toolCalls.values()) {
        if (Math.hypot(cx - tc.x, cy - tc.y) < radius + estimateToolNodeRadius(tc.toolName) + TOOL_SLOT.gap) count++
      }
      for (const other of agents.values()) {
        if (Math.hypot(cx - other.x, cy - other.y) < radius + agentFootprint(other) + TOOL_SLOT.gap) count++
      }
      return count
    }

    let outAngle = -Math.PI / 2
    if (agent.parentId) {
      const parent = agents.get(agent.parentId)
      if (parent) {
        outAngle = Math.atan2(agent.y - parent.y, agent.x - parent.x)
      }
    }

    // Try slots on rings sweeping outward from the agent, away from its parent;
    // if every one is taken, use the outermost ring's slot that clashes least
    let best: { x: number; y: number } | undefined
    let bestClashes = Infinity
    for (let ring = 1; ring <= TOOL_SLOT.maxRings; ring++) {
      const dist = TOOL_SLOT.baseDistance + ring * TOOL_SLOT.ringIncrement
      const steps = TOOL_SLOT.baseSteps + ring * TOOL_SLOT.stepsPerRing
      for (let i = 0; i < steps; i++) {
        const sweep = (i / (steps - 1) - 0.5) * Math.PI
        const angle = outAngle + sweep
        const cx = agent.x + Math.cos(angle) * dist
        const cy = agent.y + Math.sin(angle) * dist
        const count = clashes(cx, cy)
        if (count === 0) return { x: cx, y: cy }
        if (ring === TOOL_SLOT.maxRings && count < bestClashes) { bestClashes = count; best = { x: cx, y: cy } }
      }
    }
    return best! // the outermost ring always sets it
  }, [])

  const processEventWithContext = useCallback((event: GraphEvent, prev: GraphState): GraphState => {
    const ctx: ProcessEventContext = { findToolSlot }
    return processEvent(event, prev, ctx)
  }, [findToolSlot])

  // ─── Animation loop ──────────────────────────────────────────────────────
  // Reads/writes graphRef directly; React state is only touched when the
  // loop starts/stops or the graph's emptiness changes.
  const animate = useCallback((timestamp: number) => {
    // Cap at 60fps to reduce CPU/GPU load
    const elapsed = timestamp - lastTimeRef.current
    if (lastTimeRef.current && elapsed < ANIM_SPEED.minFrameInterval) {
      animationRef.current = requestAnimationFrame(animateRef.current)
      return
    }

    if (!lastTimeRef.current) lastTimeRef.current = timestamp
    const deltaTime = Math.min((timestamp - lastTimeRef.current) / 1000, ANIM_SPEED.maxDeltaTime)
    lastTimeRef.current = timestamp

    const prev = graphRef.current
    if (!prev.isPlaying) {
      animationRef.current = requestAnimationFrame(animateRef.current)
      return
    }

    // Copy the external events, then mark them consumed: the relay empties the
    // shared pending array in place
    let capturedEvents: GraphEvent[] | null = null
    if (externalEvents.length > 0 && !useMockData) {
      capturedEvents = externalEvents.slice()
      onExternalEventsConsumed()
    }

    let newTime = prev.currentTime + deltaTime
    let newEventIndex = prev.eventIndex

    // Process events — thread state through each event
    let currentState = prev

    if (useMockData) {
      while (newEventIndex < MOCK_SCENARIO.length && MOCK_SCENARIO[newEventIndex].time <= newTime) {
        const evt = MOCK_SCENARIO[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEventIndex++
      }
    }

    // Process the external events copied above
    if (capturedEvents) {
      for (const event of capturedEvents) {
        const eventTime = Math.max(event.time || newTime, newTime)
        const timedEvent = { ...event, time: eventTime }
        currentState = { ...currentState, currentTime: eventTime }
        currentState = processEventWithContext(timedEvent, currentState)
      }
      // Sync the graph clock to latest event so active state renders correctly
      newTime = Math.max(newTime, currentState.currentTime)
    }

    currentState = { ...currentState, eventIndex: newEventIndex }

    const result = computeNextFrame(deltaTime, newTime, currentState, {
      useMockData,
      mockScenarioLength: MOCK_SCENARIO.length,
      mockScenarioEndTime: MOCK_SCENARIO.length > 0 ? MOCK_SCENARIO[MOCK_SCENARIO.length - 1].time : 0,
    })

    // Write to graphRef (canvas reads this every frame); React only hears about
    // the loop starting/stopping or the graph becoming empty/non-empty
    graphRef.current = result
    if (result.isPlaying !== prev.isPlaying || (result.agents.size > 0) !== hasAgentsRef.current) syncReactState(result)

    animationRef.current = requestAnimationFrame(animateRef.current)
  }, [processEventWithContext, useMockData, externalEvents, onExternalEventsConsumed, syncReactState])

  animateRef.current = animate

  useEffect(() => {
    const loop = (timestamp: number) => animateRef.current(timestamp)
    if (isPlaying) {
      lastTimeRef.current = 0
      animationRef.current = requestAnimationFrame(loop)
    }
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  }, [isPlaying])

  // ─── Start / reset ───────────────────────────────────────────────────────
  const play = useCallback(() => {
    const next = { ...graphRef.current, isPlaying: true }
    commitState(next)
  }, [commitState])

  const restart = useCallback(() => {
    commitState(createEmptyState({ isPlaying: true }))
  }, [commitState])

  // ─── Session state save/restore ──────────────────────────────────────────
  const saveSnapshot = useCallback((): GraphState => graphRef.current, [])

  const restoreSnapshot = useCallback((snapshot: GraphState) => {
    commitState({ ...snapshot, isPlaying: true })
  }, [commitState])

  return {
    graphRef,
    hasAgents,
    play, restart,
    saveSnapshot, restoreSnapshot,
  }
}
