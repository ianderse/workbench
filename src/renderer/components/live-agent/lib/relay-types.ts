/**
 * Types for messages streamed by the relay over SSE.
 *
 * These mirror relay/lib/protocol.ts — keep the two in sync.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

export interface SessionInfo {
  id: string
  status: 'active' | 'completed'
  lastActivityTime: number
  /** The agent window (terminal id) it runs in, once its hooks have said;
   *  none for a session run outside Workbench's agent windows */
  owner?: string
}
