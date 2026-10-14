import type { Agent, ToolCallNode, Edge, GraphEvent } from '../../lib/agent-types'
import type { GraphState } from './types'
import { handleAgentSpawn, handleAgentComplete, handlePermissionRequested } from './handle-agent-events'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage } from './handle-message-events'

export interface ProcessEventContext {
  findToolSlot: (agent: Agent, agents: Map<string, Agent>, toolCalls: Map<string, ToolCallNode>, toolName: string) => { x: number; y: number }
}

/** Mutable collections that handlers mutate in place during a single processEvent call. */
export interface MutableEventState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  edges: Edge[]
}

export function processEvent(event: GraphEvent, prev: GraphState, ctx: ProcessEventContext): GraphState {
  const state: MutableEventState = {
    agents: new Map(prev.agents),
    toolCalls: new Map(prev.toolCalls),
    edges: [...prev.edges],
  }

  switch (event.type) {
    case 'agent_spawn':       handleAgentSpawn(event.payload, state); break
    case 'agent_complete':    handleAgentComplete(event.payload, prev.currentTime, state); break
    case 'tool_call_start':   handleToolCallStart(event.payload, event.time, state, ctx); break
    case 'tool_call_end':     handleToolCallEnd(event.payload, prev.currentTime, state); break
    case 'message':           handleMessage(event.payload, state); break
    case 'permission_requested': handlePermissionRequested(event.payload, state); break
  }

  return {
    ...prev,
    agents: state.agents, toolCalls: state.toolCalls, edges: state.edges,
  }
}
