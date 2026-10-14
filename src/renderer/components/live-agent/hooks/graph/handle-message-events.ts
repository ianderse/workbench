import { asString, isLive } from './types'
import type { MutableEventState } from './process-event'

/** The agent produced a message or thought: it's thinking (unless it's in the
 *  middle of a tool call). A finished main agent wakes up for its next turn. */
export function handleMessage(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const agent = state.agents.get(agentName)
  if (agent && isLive(agent) && agent.state !== 'tool_calling') {
    state.agents.set(agentName, { ...agent, state: 'thinking' })
  }
}
