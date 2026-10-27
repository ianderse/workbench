import { NODE, type Agent } from '../../lib/agent-types'
import { AGENT_DRAW } from '../../lib/canvas-constants'
import type { MutableEventState } from './process-event'
import { findFreeSlot } from './find-slot'
import { asString, asBoolean } from './types'

/** A direction of its own for a node with nothing around it yet */
function hashAngle(name: string): number {
  const hash = name.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)
  return (Math.abs(hash) % 360) * (Math.PI / 180)
}

/** The middle of the widest direction still free around the parent */
function widestGapAngle(name: string, parent: Agent, state: MutableEventState): number {
  // Directions already taken around the parent: its other sub-agents, its own
  // parent, and its tool calls
  const takenAngles: number[] = []
  const take = (node: { x: number; y: number }) => takenAngles.push(Math.atan2(node.y - parent.y, node.x - parent.x))
  for (const agent of state.agents.values()) {
    if (agent.parentId === parent.id || agent.id === parent.parentId) take(agent)
  }
  for (const tc of state.toolCalls.values()) {
    if (tc.agentId === parent.id) take(tc)
  }

  // Nothing around it yet: use a hash-based angle
  if (takenAngles.length === 0) return hashAngle(name)

  takenAngles.sort((a, b) => a - b)
  let bestGap = 0
  let bestMid = takenAngles[0] + Math.PI
  for (let i = 0; i < takenAngles.length; i++) {
    const next = i + 1 < takenAngles.length ? takenAngles[i + 1] : takenAngles[0] + Math.PI * 2
    const gap = next - takenAngles[i]
    if (gap > bestGap) {
      bestGap = gap
      bestMid = takenAngles[i] + gap / 2
    }
  }
  return bestMid
}

export function handleAgentSpawn(
  payload: Record<string, unknown>,
  eventTime: number,
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
    // Out through the widest gap between what already hangs off the parent, then
    // wherever near that direction the node covers nothing else
    const pos = findFreeSlot({
      parent: { id: parent.id, x: parent.x, y: parent.y, radius: parent.isMain ? NODE.radiusMain : NODE.radiusSub },
      radius: NODE.radiusSub,
      footprint: NODE.radiusSub + AGENT_DRAW.glowPadding,
      preferredAngle: widestGapAngle(name, parent, state),
      agents: state.agents,
      toolCalls: state.toolCalls,
    })
    x = pos.x
    y = pos.y
  } else {
    // Nothing to hang off (the main agent, or a sub-agent seen before the agent it belongs to):
    // the middle, unless something already sits there, then the nearest free spot around it
    const radius = isMain ? NODE.radiusMain : NODE.radiusSub
    const pos = findFreeSlot({
      parent: { id: '', x: 0, y: 0, radius: 0 },
      radius,
      footprint: radius + AGENT_DRAW.glowPadding,
      preferredAngle: hashAngle(name),
      agents: state.agents,
      toolCalls: state.toolCalls,
      atParent: true,
    })
    x = pos.x
    y = pos.y
  }

  const agent: Agent = {
    // A sub-agent is launched with work to do, so it is working from the start: drawn idle until
    // its first message, it sat there looking idle for as long as it took to start, which for a
    // fork (it takes the whole conversation along) is a good while. The main agent starts out
    // waiting for a prompt. One that does nothing (e.g. a dead one found again on re-attach)
    // falls back to idle after a while (see animate.ts)
    id: name, state: isMain ? 'idle' : 'thinking',
    parentId: parentId || null,
    x, y,
    isMain,
    isSatellite: asBoolean(payload.satellite) || undefined,
    opacity: 0,
  }
  state.agents.set(name, agent)
  if (!isMain) state.quietSubagents.set(name, eventTime)

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
