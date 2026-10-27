import type { Agent, ToolCallNode, Edge, GraphEvent } from '../../lib/agent-types'
import { asString, type GraphState } from './types'
import { handleAgentSpawn, handleAgentComplete, handlePermissionRequested } from './handle-agent-events'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage } from './handle-message-events'

/** Mutable collections that handlers mutate in place during a single processEvent call. */
export interface MutableEventState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  edges: Edge[]
  quietSubagents: Map<string, number>
}

export function processEvent(event: GraphEvent, prev: GraphState): GraphState {
  const state: MutableEventState = {
    agents: new Map(prev.agents),
    toolCalls: new Map(prev.toolCalls),
    edges: [...prev.edges],
    quietSubagents: new Map(prev.quietSubagents),
  }

  // Anything a sub-agent does ends its quiet start
  if (event.type !== 'agent_spawn') {
    state.quietSubagents.delete(asString(event.payload.agent) || asString(event.payload.name))
  }

  switch (event.type) {
    case 'agent_spawn':       handleAgentSpawn(event.payload, event.time, state); break
    case 'agent_complete':    handleAgentComplete(event.payload, prev.currentTime, state); break
    case 'tool_call_start':   handleToolCallStart(event.payload, event.time, state); break
    case 'tool_call_end':     handleToolCallEnd(event.payload, prev.currentTime, state); break
    case 'message':           handleMessage(event.payload, state); break
    case 'permission_requested': handlePermissionRequested(event.payload, state); break
  }

  return {
    ...prev,
    agents: state.agents, toolCalls: state.toolCalls, edges: state.edges,
    quietSubagents: state.quietSubagents,
  }
}
