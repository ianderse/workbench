import type {
  Agent,
  AgentState,
  ToolCallNode,
  Edge,
  GraphEvent,
} from '../../lib/agent-types'

export interface GraphState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  edges: Edge[]
  /** Sub-agents that have done nothing since they spawned, with the graph time
   *  they spawned: drawn working meanwhile, until SUBAGENT_START_QUIET_S passes */
  quietSubagents: Map<string, number>
  currentTime: number
  isPlaying: boolean
  /** Position in MOCK_SCENARIO (demo mode only) */
  eventIndex: number
}

/** Create an empty graph state, optionally preserving specific fields */
export function createEmptyState(overrides?: Partial<GraphState>): GraphState {
  return {
    agents: new Map(),
    toolCalls: new Map(),
    edges: [],
    quietSubagents: new Map(),
    currentTime: 0,
    isPlaying: false,
    eventIndex: 0,
    ...overrides,
  }
}

// ── Safe payload extraction helpers ──────────────────────────────────
export function asString(v: unknown): string { return typeof v === 'string' ? v : '' }
export function asBoolean(v: unknown): boolean { return typeof v === 'boolean' ? v : false }

/** Whether an agent still reacts to events: a finished sub-agent stays finished
 *  (late events don't revive it); the main agent comes back for its next turn. */
export function isLive(agent: Agent): boolean {
  return agent.state !== 'complete' || agent.isMain
}

/** Agents with a sub-agent still working under them, at any depth: they're waiting on it */
export function agentsAwaitingSubagents(agents: Map<string, Agent>): Set<string> {
  const awaiting = new Set<string>()
  for (const agent of agents.values()) {
    if (agent.state === 'complete') continue
    let parentId = agent.parentId
    while (parentId && !awaiting.has(parentId)) {
      awaiting.add(parentId)
      parentId = agents.get(parentId)?.parentId ?? null
    }
  }
  return awaiting
}

/** The state an agent is shown in: one waiting on its sub-agents is still busy,
 *  shown as thinking like them (e.g. the main agent after its turn, with a
 *  background agent running) */
export function displayedState(agent: Agent, awaiting: Set<string>): AgentState {
  return (agent.state === 'complete' || agent.state === 'idle') && awaiting.has(agent.id) ? 'thinking' : agent.state
}

export interface UseGraphStateOptions {
  /** If true, play MOCK_SCENARIO (demo mode) instead of relay events */
  useMockData: boolean
  /** External events to process (from the relay). Consumed each frame. */
  externalEvents: readonly GraphEvent[]
  /** Called once the graph has taken externalEvents (it then processes its copy) */
  onExternalEventsConsumed: () => void
}
