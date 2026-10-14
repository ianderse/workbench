import type { Agent } from '../../lib/agent-types'
import type { ProcessEventContext, MutableEventState } from './process-event'
import { asString, asBoolean, isLive } from './types'

/** Whether the agent shows a permission prompt that is still open: the call
 *  that asked for it hasn't ended. A prompt with no call (the agent had none
 *  running) ends with the agent's next tool start or message. */
function promptOpen(agent: Agent, state: MutableEventState): boolean {
  return agent.state === 'waiting_permission' && !!agent.waitingToolId
    && state.toolCalls.get(agent.waitingToolId)?.state === 'running'
}

export function handleToolCallStart(
  payload: Record<string, unknown>,
  eventTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const agent = state.agents.get(agentName)
  if (!agent || !isLive(agent)) return

  // The relay sends the tool_use ID; the demo scenario doesn't (its event time
  // keeps ids unique when several events are handled in one frame)
  const toolId = asString(payload.id) || `tool-${agentName}-${toolName}-${eventTime}`
  if (state.toolCalls.has(toolId)) return

  if (!promptOpen(agent, state)) {
    state.agents.set(agentName, { ...agent, state: 'tool_calling' })
  }

  const pos = ctx.findToolSlot(agent, state.agents, state.toolCalls, toolName)

  state.toolCalls.set(toolId, {
    agentId: agentName, toolName,
    state: 'running',
    x: pos.x,
    y: pos.y,
    startTime: eventTime,
    opacity: 0,
  })

  state.edges.push({ from: agentName, to: toolId, type: 'tool' })
}

export function handleToolCallEnd(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const toolName = asString(payload.tool)
  const isError = asBoolean(payload.isError)
  const agent = state.agents.get(agentName)
  if (!agent || !isLive(agent)) return

  // Match by tool_use ID; without one (demo scenario), the agent's oldest running call of that tool
  const payloadId = asString(payload.id)
  const match = payloadId
    ? [payloadId, state.toolCalls.get(payloadId)] as const
    : [...state.toolCalls].find(([, tc]) => tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running')
  const [id, tc] = match ?? []
  if (!id || tc?.state !== 'running') return

  state.toolCalls.set(id, { ...tc, state: isError ? 'error' : 'complete', completeTime: currentTime })

  // An open permission prompt stays shown while other calls end
  if (promptOpen(agent, state)) return

  // The agent goes back to thinking once its last running tool is done (a
  // finished agent has no running tools: completing it ended them)
  let othersRunning = false
  for (const other of state.toolCalls.values()) {
    if (other.agentId === agentName && other.state === 'running') { othersRunning = true; break }
  }
  state.agents.set(agentName, { ...agent, state: isError ? 'error' : othersRunning ? 'tool_calling' : 'thinking' })
}
