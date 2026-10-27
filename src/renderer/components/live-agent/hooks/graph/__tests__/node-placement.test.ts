import { describe, it, expect } from 'vitest'
import { NODE, type GraphEvent } from '../../../lib/agent-types'
import { AGENT_DRAW, estimateToolNodeRadius } from '../../../lib/canvas-constants'
import { createEmptyState, type GraphState } from '../types'
import { processEvent } from '../process-event'

const spawn = (name: string, parent?: string, isMain = false): GraphEvent => ({
  time: 0,
  type: 'agent_spawn',
  payload: { name, isMain, ...(parent ? { parent } : {}) },
})

const toolStart = (agent: string, tool: string, id: string): GraphEvent => ({
  time: 0,
  type: 'tool_call_start',
  payload: { agent, tool, id },
})

function play(events: GraphEvent[]): GraphState {
  return events.reduce((state, event) => processEvent(event, state), createEmptyState())
}

/** Every node as a circle: how much room it takes around its centre */
function placedNodes(state: GraphState): { id: string; x: number; y: number; radius: number }[] {
  return [
    ...[...state.agents.values()].map((agent) => ({
      id: agent.id,
      x: agent.x,
      y: agent.y,
      radius: (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AGENT_DRAW.glowPadding,
    })),
    ...[...state.toolCalls].map(([id, tool]) => ({
      id,
      x: tool.x,
      y: tool.y,
      radius: estimateToolNodeRadius(tool.toolName),
    })),
  ]
}

/** Pairs of nodes drawn on top of each other */
function overlaps(state: GraphState): string[] {
  const nodes = placedNodes(state)
  const hits: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius) hits.push(`${a.id} / ${b.id}`)
    }
  }
  return hits
}

describe('node placement', () => {
  it('keeps a busy graph free of overlapping nodes', () => {
    // The shape a working session takes: a main agent, sub-agents under it, and
    // a handful of Bash calls under each
    const events: GraphEvent[] = [spawn('main', undefined, true)]
    for (const tool of ['Read', 'Grep', 'Bash']) {
      events.push(toolStart('main', tool, `main-${tool}`))
    }
    for (let i = 0; i < 6; i++) {
      const sub = `sub-${i}`
      events.push(spawn(sub, 'main'))
      for (let t = 0; t < 3; t++) {
        events.push(toolStart(sub, 'Bash', `${sub}-bash-${t}`))
      }
    }

    const state = play(events)

    expect(state.agents.size).toBe(7)
    expect(state.toolCalls.size).toBe(21)
    expect(overlaps(state)).toEqual([])
  })

  it('keeps nested branches apart', () => {
    // Sub-agents of sub-agents grow into the space around the main agent
    const events: GraphEvent[] = [spawn('main', undefined, true)]
    for (let i = 0; i < 4; i++) {
      events.push(spawn(`sub-${i}`, 'main'), toolStart(`sub-${i}`, 'Bash', `sub-${i}-bash`))
      for (let j = 0; j < 2; j++) {
        events.push(spawn(`sub-${i}-${j}`, `sub-${i}`), toolStart(`sub-${i}-${j}`, 'Bash', `sub-${i}-${j}-bash`))
      }
    }

    expect(overlaps(play(events))).toEqual([])
  })

  it('stays clear even when the graph is crowded', () => {
    // What a long session builds up to: many agents, each with several calls
    const events: GraphEvent[] = [spawn('main', undefined, true)]
    for (let i = 0; i < 10; i++) {
      events.push(spawn(`sub-${i}`, 'main'))
      for (let t = 0; t < 5; t++) events.push(toolStart(`sub-${i}`, 'Bash', `sub-${i}-bash-${t}`))
    }

    const state = play(events)
    const nodes = placedNodes(state)

    expect(nodes).toHaveLength(61)
    expect(overlaps(state)).toEqual([])
    // And it stays compact enough to frame: the graph spreads, it doesn't sprawl
    const spread = Math.max(...nodes.map((node) => Math.hypot(node.x, node.y)))
    expect(spread).toBeLessThan(500)
  })

  it('places the first node of a branch in its preferred direction', () => {
    const state = play([spawn('main', undefined, true), spawn('sub', 'main')])
    const sub = state.agents.get('sub')!
    const distance = Math.hypot(sub.x, sub.y)

    // Straight out of the main agent at the usual distance, nothing in the way
    expect(distance).toBeCloseTo(NODE.radiusMain * 3 + NODE.radiusSub + 8, 5)
  })

  it('hangs a nested agent off its own parent at the same distance', () => {
    // The parent is never "in the way" of its own child: the distance already clears it
    const state = play([spawn('main', undefined, true), spawn('sub', 'main'), spawn('subsub', 'sub')])
    const sub = state.agents.get('sub')!
    const subsub = state.agents.get('subsub')!

    expect(Math.hypot(subsub.x - sub.x, subsub.y - sub.y))
      .toBeCloseTo(NODE.radiusSub * 3 + NODE.radiusSub + 8, 5)
  })

  it('keeps the main agent off a sub-agent that was seen before it', () => {
    // Attaching mid-session: a sub-agent whose parent isn't known yet, then the main agent
    const state = play([
      spawn('early', 'orchestrator'),
      toolStart('early', 'Read', 'early-read'),
      spawn('main', undefined, true),
      spawn('late', 'orchestrator'),
    ])

    expect(state.agents.size).toBe(3)
    expect(overlaps(state)).toEqual([])
  })

  it('gives a full graph longer edges instead of overlapping nodes', () => {
    // More calls than the rings near the main agent can hold
    const events: GraphEvent[] = [spawn('main', undefined, true)]
    for (let t = 0; t < 400; t++) events.push(toolStart('main', 'Bash', `main-bash-${t}`))

    const state = play(events)

    expect(state.toolCalls.size).toBe(400)
    expect(overlaps(state)).toEqual([])
  })
})
