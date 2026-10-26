import type { Agent, ToolCallNode } from '../../lib/agent-types'
import type { GraphState } from './types'
import { agentsAwaitingSubagents } from './types'
import {
  ANSWER_HOLD_S,
  TOOL_MIN_VISIBLE_S,
  MOCK_END_BUFFER_S,
  ANIM_SPEED,
} from '../../lib/canvas-constants'

/** How long a sub-agent is drawn working with nothing from it yet. One that
 *  starts slowly (a fork takes the whole conversation along) has said
 *  something by then; one that hasn't (e.g. a dead one found again on
 *  re-attach, which the relay only finishes once it has long gone quiet) falls
 *  back to idle instead of pulsing on */
export const SUBAGENT_START_QUIET_S = 120

interface AnimateOptions {
  useMockData: boolean
  mockScenarioLength: number
  mockScenarioEndTime: number
}

/** A finished sub-agent whose answer has been shown flowing back to its
 *  parent, and that isn't waiting on sub-agents of its own (they'd lose their
 *  parent): it is fading out and, with it, merging back into the parent */
function isFadingOut(agent: Agent, time: number, awaiting: Set<string>): boolean {
  return agent.state === 'complete' && !agent.isMain && !awaiting.has(agent.id)
    && time - (agent.completeTime ?? 0) >= ANSWER_HOLD_S
}

/** A finished tool call whose answer has been shown flowing back to its agent,
 *  and that has been on screen long enough to read */
function isToolFadingOut(tc: ToolCallNode, time: number): boolean {
  return tc.state !== 'running' && time - (tc.completeTime ?? 0) >= ANSWER_HOLD_S
    && time - tc.startTime >= TOOL_MIN_VISIBLE_S
}

function animateAgents(agents: GraphState['agents'], deltaTime: number, newTime: number): GraphState['agents'] {
  const awaiting = agentsAwaitingSubagents(agents)
  let newAgents = agents
  for (const [id, agent] of agents) {
    let updated = false
    let opacity = agent.opacity

    // A finished sub-agent holds while its answer flows back to the parent,
    // then fades out as it is drawn back into it; everything else, and a
    // finished sub-agent during its hold (it may finish before it has faded
    // in), fades in fully
    if (isFadingOut(agent, newTime, awaiting)) {
      if (opacity > 0) { opacity = Math.max(0, opacity - deltaTime * ANIM_SPEED.agentFadeOut); updated = true }
    } else {
      if (opacity < 1) { opacity = Math.min(1, opacity + deltaTime * ANIM_SPEED.agentFadeIn); updated = true }
    }
    if (updated) {
      if (newAgents === agents) newAgents = new Map(agents)
      newAgents.set(id, { ...agent, opacity })
    }
  }
  return newAgents
}

/** Sub-agents still quiet SUBAGENT_START_QUIET_S after they spawned go idle */
function settleQuietSubagents(
  agents: GraphState['agents'],
  quiet: GraphState['quietSubagents'],
  time: number,
): { agents: GraphState['agents']; quietSubagents: GraphState['quietSubagents'] } {
  let newAgents = agents
  let newQuiet = quiet
  for (const [id, since] of quiet) {
    if (time - since < SUBAGENT_START_QUIET_S) continue
    if (newQuiet === quiet) newQuiet = new Map(quiet)
    newQuiet.delete(id)
    const agent = newAgents.get(id)
    if (agent?.state === 'thinking') {
      if (newAgents === agents) newAgents = new Map(agents)
      newAgents.set(id, { ...agent, state: 'idle' })
    }
  }
  return { agents: newAgents, quietSubagents: newQuiet }
}

function animateToolCalls(toolCalls: GraphState['toolCalls'], deltaTime: number, newTime: number): GraphState['toolCalls'] {
  let newToolCalls = toolCalls
  for (const [id, tc] of toolCalls) {
    // Stays while it runs (an agent completing closes its running tools); once
    // finished, holds while its answer flows back to the agent, then fades
    const newOpacity = isToolFadingOut(tc, newTime)
      ? Math.max(0, tc.opacity - deltaTime * ANIM_SPEED.toolFadeOut)
      : Math.min(1, tc.opacity + deltaTime * ANIM_SPEED.toolFadeIn)
    if (newOpacity !== tc.opacity) {
      if (newToolCalls === toolCalls) newToolCalls = new Map(toolCalls)
      newToolCalls.set(id, { ...tc, opacity: newOpacity })
    }
  }
  return newToolCalls
}

function cleanupFaded(
  agents: GraphState['agents'],
  toolCalls: GraphState['toolCalls'],
  edges: GraphState['edges'],
  originalAgents: GraphState['agents'],
  originalToolCalls: GraphState['toolCalls'],
  time: number,
): { agents: GraphState['agents']; toolCalls: GraphState['toolCalls']; edges: GraphState['edges'] } {
  let newAgents = agents
  let newToolCalls = toolCalls
  let filteredEdges = edges

  // Cleanup faded agents (completed sub-agents) and their edges. Only ones that
  // have faded out: a node that hasn't faded in yet is at opacity 0 too.
  const awaiting = agentsAwaitingSubagents(newAgents)
  const fadedAgentIds: string[] = []
  for (const [id, agent] of newAgents) {
    if (agent.opacity <= 0 && isFadingOut(agent, time, awaiting)) {
      fadedAgentIds.push(id)
    }
  }
  if (fadedAgentIds.length > 0) {
    if (newAgents === originalAgents) newAgents = new Map(originalAgents)
    const fadedSet = new Set(fadedAgentIds)
    for (const id of fadedAgentIds) newAgents.delete(id)
    filteredEdges = filteredEdges.filter(e => !fadedSet.has(e.from) && !fadedSet.has(e.to))
  }

  // Cleanup faded tool calls (opacity <= 0) and their edges
  const fadedToolIds: string[] = []
  for (const [id, tc] of newToolCalls) {
    if (tc.opacity <= 0 && isToolFadingOut(tc, time)) fadedToolIds.push(id)
  }
  if (fadedToolIds.length > 0) {
    if (newToolCalls === originalToolCalls) newToolCalls = new Map(originalToolCalls)
    const fadedSet = new Set(fadedToolIds)
    for (const id of fadedToolIds) newToolCalls.delete(id)
    filteredEdges = filteredEdges.filter(e => !(e.type === 'tool' && fadedSet.has(e.to)))
  }

  return { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges }
}

export function computeNextFrame(deltaTime: number, newTime: number, currentState: GraphState, options: AnimateOptions): GraphState {
  const settled = settleQuietSubagents(currentState.agents, currentState.quietSubagents, newTime)
  const newAgentsRaw = animateAgents(settled.agents, deltaTime, newTime)
  const newToolCallsRaw = animateToolCalls(currentState.toolCalls, deltaTime, newTime)

  const { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges } =
    cleanupFaded(newAgentsRaw, newToolCallsRaw, currentState.edges, currentState.agents, currentState.toolCalls, newTime)

  const next: GraphState = {
    ...currentState, currentTime: newTime, quietSubagents: settled.quietSubagents,
    agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges,
  }

  // Stop playback when the demo scenario ends
  if (options.useMockData && currentState.eventIndex >= options.mockScenarioLength && newTime > options.mockScenarioEndTime + MOCK_END_BUFFER_S) {
    return { ...next, isPlaying: false }
  }
  return next
}
