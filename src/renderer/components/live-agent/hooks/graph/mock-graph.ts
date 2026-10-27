import type { AgentState, GraphEvent } from '../../lib/agent-types'
import { createEmptyState, type GraphState } from './types'
import { processEvent } from './process-event'

/** The sub-agent states shown, one sub-agent each (every agent color) */
const AGENT_STATES: AgentState[] = ['idle', 'thinking', 'tool_calling', 'complete', 'error', 'waiting_permission']

/**
 * A still graph with every kind of node in every color, for the simulation page in Settings: the
 * master node with a sub-agent in each state, a background session (subtask), and tool calls
 * running, finished and failed. Built in place rather than played, so nothing in it fades away:
 * it is meant to be shown without the graph's animation running.
 */
export function buildMockGraph(): GraphState {
  let state = createEmptyState()
  const apply = (type: GraphEvent['type'], payload: Record<string, unknown>) => {
    state = processEvent({ time: 0, type, payload }, state)
  }

  // Laid out the way they would be live
  apply('agent_spawn', { name: 'main', isMain: true })
  for (const agentState of AGENT_STATES) apply('agent_spawn', { name: `subagent-${agentState}`, parent: 'main' })
  apply('agent_spawn', { name: 'subtask', parent: 'main', satellite: true })
  apply('tool_call_start', { agent: 'main', tool: 'Read', id: 'tool-running' })
  apply('tool_call_start', { agent: 'main', tool: 'Edit', id: 'tool-complete' })
  apply('tool_call_start', { agent: 'main', tool: 'Bash', id: 'tool-error' })
  apply('tool_call_start', { agent: 'subagent-tool_calling', tool: 'Grep', id: 'subagent-tool' })
  apply('tool_call_start', { agent: 'subagent-waiting_permission', tool: 'Write', id: 'permission-tool' })
  apply('tool_call_start', { agent: 'subtask', tool: 'Glob', id: 'subtask-tool' })

  // Then put in their states, fully shown
  const agents = new Map(state.agents)
  for (const [id, agent] of agents) {
    const shown = id === 'main' ? 'thinking' : AGENT_STATES.find((s) => id === `subagent-${s}`) ?? agent.state
    agents.set(id, {
      ...agent,
      state: shown,
      opacity: 1,
      ...(shown === 'complete' ? { completeTime: 0 } : {}),
      ...(shown === 'waiting_permission' ? { waitingToolId: 'permission-tool' } : {}),
    })
  }
  const toolCalls = new Map(state.toolCalls)
  for (const [id, tool] of toolCalls) {
    const shown = id === 'tool-complete' ? 'complete' : id === 'tool-error' ? 'error' : 'running'
    toolCalls.set(id, { ...tool, state: shown, opacity: 1, ...(shown === 'running' ? {} : { completeTime: 0 }) })
  }
  return { ...state, agents, toolCalls, quietSubagents: new Map(), isPlaying: false }
}
