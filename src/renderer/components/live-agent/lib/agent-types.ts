export type AgentState = 'idle' | 'thinking' | 'tool_calling' | 'complete' | 'error' | 'waiting_permission'

export interface Agent {
  id: string
  state: AgentState
  parentId: string | null
  x: number
  y: number
  isMain: boolean
  /** A background agent session the user started (Claude Code's /subtask), which the relay
   *  reports like a sub-agent: drawn as one, with a square border */
  isSatellite?: boolean
  /** Graph clock time the agent last completed, or a sub-agent under it last
   *  did: starts a finished sub-agent's ANSWER_HOLD_S hold before it fades out
   *  (only read for one; a sub-agent never leaves 'complete') */
  completeTime?: number
  /** The running tool call that asked for permission (only read while the
   *  agent is waiting for it; each prompt sets it) */
  waitingToolId?: string
  opacity: number
}

export interface ToolCallNode {
  agentId: string
  toolName: string
  state: 'running' | 'complete' | 'error'
  x: number
  y: number
  /** Graph clock time the node appeared (keeps it TOOL_MIN_VISIBLE_S on screen) */
  startTime: number
  completeTime?: number // when the tool call completed (starts the ANSWER_HOLD_S hold)
  opacity: number
}

export interface Edge {
  from: string
  to: string
  type: 'parent-child' | 'tool'
}

export interface GraphEvent {
  time: number
  type:
    | 'agent_spawn'
    | 'agent_complete'
    | 'message'
    | 'tool_call_start'
    | 'tool_call_end'
    | 'permission_requested'
  payload: Record<string, unknown>
}

// ─── Layout Constants ────────────────────────────────────────────────────────

export const NODE = {
  radiusMain: 28,
  radiusSub: 20,
} as const

// ─── Animation Constants ─────────────────────────────────────────────────────

export const TIMING = {
  autoPlayDelayMs: 500,
} as const

export const ANIM = {
  autoFitLerp: 0.06,
  breathe: {
    thinkingSpeed: 2, thinkingAmp: 0.03,
    idleSpeed: 0.7, idleAmp: 0.015,
  },
  scanline: { thinking: 40, normal: 15 },
} as const

export const FX = {
  spawnDuration: 0.8,
  shatterDuration: 0.8,
  shatterCount: 12,
  shatterSpeed: { min: 30, range: 60 },
  shatterSize: { min: 1, range: 2 },
} as const

/** Edges: dashed curves whose dashes flow toward a target working on a
 *  request, and back from one that has answered */
export const BEAM = {
  curvature: 0.15,
  cp1: 0.33,
  cp2: 0.66,
  width: { parentChild: 2, tool: 1.5 },
  /** Dash and gap length (world units) */
  dash: [6, 5],
  /** How fast the dashes flow (world units per second) */
  flowSpeed: 30,
  alpha: 0.75,
  /** Faint solid line under the dashes */
  glow: { width: 5, alpha: 0.08 },
  /** Gap between a node's border and where its edges start (world units) */
  nodeGap: 4,
  /** Length over which an edge fades in from each end (world units) */
  endFade: 24,
  /** How strongly the part of an edge that passes under another node is drawn
   *  (a share of its full strength, see drawEdges) */
  underNode: 0.15,
} as const
