import type { Agent } from '../../lib/agent-types'
import { AGENT_SPAWN_DISTANCE } from '../../lib/canvas-constants'
import type { MutableEventState } from './process-event'
import { asString, asBoolean } from './types'

export function handleAgentSpawn(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const name = asString(payload.name)
  const isMain = asBoolean(payload.isMain)

  // The agent already exists: a finished main agent comes back (the session
  // resumes after inactivity); anything else is left as it is (a finished
  // sub-agent stays finished, a busy agent keeps working)
  const existing = state.agents.get(name)
  if (existing) {
    if (existing.isMain && existing.state === 'complete') {
      state.agents.set(name, { ...existing, state: 'idle' })
    }
    return
  }

  // A parent no longer shown (it finished and faded out): attach it to the main agent
  let parentId = typeof payload.parent === 'string' ? payload.parent : undefined
  if (parentId && !state.agents.has(parentId)) {
    parentId = [...state.agents.values()].find(a => a.isMain)?.id
  }

  let x = 0, y = 0
  const parent = parentId ? state.agents.get(parentId) : undefined
  if (parent) {
    // Directions already taken around the parent: its other sub-agents, its
    // own parent, and its tool calls
    const takenAngles: number[] = []
    const take = (node: { x: number; y: number }) => takenAngles.push(Math.atan2(node.y - parent.y, node.x - parent.x))
    for (const a of state.agents.values()) {
      if (a.parentId === parentId || a.id === parent.parentId) take(a)
    }
    for (const tc of state.toolCalls.values()) {
      if (tc.agentId === parentId) take(tc)
    }

    let angle: number
    if (takenAngles.length === 0) {
      // Nothing around it yet: use a hash-based angle
      const hash = name.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)
      angle = (Math.abs(hash) % 360) * (Math.PI / 180)
    } else {
      // Place it in the middle of the largest free gap
      takenAngles.sort((a, b) => a - b)
      let bestGap = 0
      let bestMid = 0
      for (let i = 0; i < takenAngles.length; i++) {
        const next = i + 1 < takenAngles.length ? takenAngles[i + 1] : takenAngles[0] + Math.PI * 2
        const gap = next - takenAngles[i]
        if (gap > bestGap) {
          bestGap = gap
          bestMid = takenAngles[i] + gap / 2
        }
      }
      angle = bestMid
    }

    x = parent.x + Math.cos(angle) * AGENT_SPAWN_DISTANCE
    y = parent.y + Math.sin(angle) * AGENT_SPAWN_DISTANCE
  }

  const agent: Agent = {
    id: name, state: 'idle',
    parentId: parentId || null,
    x, y,
    isMain,
    isSatellite: asBoolean(payload.satellite) || undefined,
    opacity: 0, scale: 0.3,
  }
  state.agents.set(name, agent)

  if (parentId) {
    state.edges.push({ from: parentId, to: name, type: 'parent-child' })
  }
}

/**
 * Complete the named agent and its running tools. Children are NOT completed
 * with it: when the main agent finishes its turn (Stop hook), background
 * sub-agents keep running and complete through their own events. Only when the
 * whole session is over (`endsSession`) is everything still open completed.
 */
export function handleAgentComplete(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const name = asString(payload.name)
  const endsSession = asBoolean(payload.endsSession)

  const completed = new Set<string>()
  for (const [id, agent] of state.agents) {
    if ((endsSession || id === name) && agent.state !== 'complete') {
      state.agents.set(id, { ...agent, state: 'complete', completeTime: currentTime })
      completed.add(id)
    }
  }

  for (const [tcId, tc] of state.toolCalls) {
    if (completed.has(tc.agentId) && tc.state === 'running') {
      state.toolCalls.set(tcId, { ...tc, state: 'complete', completeTime: currentTime })
    }
  }

  // Finished ancestors were waiting on it: their hold (see animate.ts) starts
  // now, so they stay while its answer flows back to them
  const held = new Set<string>()
  const parentOf = (agent: Agent | undefined) => agent?.parentId ? state.agents.get(agent.parentId) : undefined
  for (const id of completed) {
    for (let parent = parentOf(state.agents.get(id)); parent && !held.has(parent.id); parent = parentOf(parent)) {
      held.add(parent.id)
      if (parent.state === 'complete') state.agents.set(parent.id, { ...parent, completeTime: currentTime })
    }
  }
}

export function handlePermissionRequested(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const agent = state.agents.get(agentName)
  if (!agent || agent.state === 'complete') return
  // The prompt is for the call it started last (its PreToolUse comes just before)
  let waitingToolId: string | undefined
  for (const [id, tc] of state.toolCalls) {
    if (tc.agentId === agentName && tc.state === 'running') waitingToolId = id
  }
  state.agents.set(agentName, { ...agent, state: 'waiting_permission', waitingToolId })
}
