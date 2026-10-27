/**
 * Event and transcript types shared across the relay.
 */

import { ORCHESTRATOR_NAME } from './constants'

// ─── Agent Event Types (from real agent sessions) ────────────────────────────

type AgentEventType =
  | 'agent_spawn'
  | 'agent_complete'
  | 'message'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'permission_requested'

export interface AgentEvent {
  time: number
  type: AgentEventType
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

// ─── Transcript Types (from Claude Code JSONL files) ─────────────────────────

export interface TranscriptEntry {
  type: string
  uuid?: string
  message: {
    role: string
    content: Array<TranscriptContentBlock> | string
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  name: string
  id: string
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

type TranscriptContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown }

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/** Minimal emitter interface used by {@link spawnSubagentNode}. */
interface AgentEventEmitter {
  emit(event: AgentEvent, sessionId: string): void
  elapsed(sessionId: string): number
}

/**
 * Give a sub-agent its node, once: an agent_spawn under the agent that
 * launched it (the main agent for a launch we don't know). A parent sub-agent
 * without a node yet (e.g. quiet when we attached) gets its own first, so the
 * child isn't drawn under another agent.
 */
export function spawnSubagentNode(emitter: AgentEventEmitter, session: WatchedSession, launchId: string): void {
  if (session.spawnedSubagents.has(launchId)) return
  session.spawnedSubagents.add(launchId)
  const parent = session.launches.get(launchId)?.parent ?? ORCHESTRATOR_NAME
  if (parent !== ORCHESTRATOR_NAME) spawnSubagentNode(emitter, session, parent)
  emitter.emit({
    time: emitter.elapsed(session.sessionId),
    type: 'agent_spawn',
    payload: { name: launchId, parent, satellite: session.launches.get(launchId)?.fork || undefined },
  }, session.sessionId)
}

/** Get (or create) the dedup state for a sub-agent launch */
export function subagentDedupFor(session: WatchedSession, launchId: string): SubagentDedup {
  let dedup = session.subagentDedup.get(launchId)
  if (!dedup) {
    dedup = { pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set() }
    session.subagentDedup.set(launchId, dedup)
  }
  return dedup
}

// ─── Shared Internal Types ───────────────────────────────────────────────────

/** A tool call that has started but not yet received its result */
export interface PendingToolCall {
  name: string
}

// ─── Session Types ──────────────────────────────────────────────────────────

/** How an Agent/Task call ran: its caller waited for it, or it went on in the background */
export type LaunchShape = 'foreground' | 'background'

/** An Agent/Task launch. Its tool_use ID is the sub-agent's node id: unique per
 *  launch, and the same ID the sub-agent's .meta.json (`toolUseId`), inline
 *  progress events (`parentToolUseID`) and <task-notification> refer to. */
export interface SubagentLaunch {
  /** Agent that launched it (the orchestrator, or a sub-agent for nested launches) */
  parent: string
  /** Seen launching, after we attached (vs found by a pre-scan of a transcript,
   *  or only known from its sub-agent's own hooks) */
  seenLive: boolean
  /** Launched in the background: finishes on its <task-notification> */
  background: boolean
  /** A background agent session the user started (Claude Code's /subtask), rather than an
   *  Agent/Task call of the agent itself: shown apart from ordinary sub-agents */
  fork?: boolean
  finished: boolean
}

/** Dedup state for one sub-agent, shared by its transcript file and any inline
 *  progress events, so the two sources never emit the same tool call or message twice */
export interface SubagentDedup {
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  seenMessageHashes: Set<string>
}

/** A tailed sub-agent transcript file */
export interface SubagentState {
  fileSize: number
  agentName: string
  dedup: SubagentDedup
  watcher: import('fs').FSWatcher | null
}

/** State tracked for a single watched Claude Code session */
export interface WatchedSession {
  sessionId: string
  filePath: string
  /** The directory it runs in, as the relay compares it (dirKey() in relay.ts):
   *  its events go to the clients of that directory */
  dirKey: string
  fileWatcher: import('fs').FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  fileSize: number
  sessionStartTime: number
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  seenMessageHashes: Set<string>
  sessionCompleted: boolean
  /** When the session was last closed (Date.now() ms) */
  closedTime: number
  /** The main agent's turn is in progress (see TranscriptParser.endTurn) */
  turnOpen: boolean
  lastActivityTime: number
  inactivityTimer: NodeJS.Timeout | null
  /** Sub-agent launches by tool_use ID */
  launches: Map<string, SubagentLaunch>
  /** Per-sub-agent dedup state by launch ID */
  subagentDedup: Map<string, SubagentDedup>
  /** Tailed sub-agent transcript files by path */
  subagentWatchers: Map<string, SubagentState>
  /** Sub-agent files not (or no longer) tailed: no launch ID in their .meta.json,
   *  none written in time, their launch is finished, or still waiting when the
   *  session closed */
  ignoredSubagentFiles: Set<string>
  /** How each Agent/Task call ran (by tool_use ID), as its sub-agent's .meta.json records it, and
   *  the .meta.json files already read for it (see launchShape in transcript-parser.ts) */
  launchShapes: Map<string, LaunchShape>
  readLaunchMetas: Set<string>
  /** When a sub-agent file was first seen without its .meta.json (it's written a moment later) */
  subagentFilesAwaitingMeta: Map<string, number>
  /** When a sub-agent file started since we attached was first seen before its
   *  launch line was read (Claude Code writes that late) */
  subagentFilesAwaitingLaunch: Map<string, number>
  /** Background sub-agent tasks (by task id) whose report already reached their
   *  caller through SubagentHandback (Claude Code 2.1.300+): their later
   *  <task-notification> starts no turn (see TranscriptParser) */
  handedBackTasks: Set<string>
  /** The sub-agent files present at attach have been scanned: any found later are live */
  attachScanDone: boolean
  /** Launch IDs that must not get a node (again): ones already given one, and
   *  finished ones that never had one */
  spawnedSubagents: Set<string>
  subagentsDirWatcher: import('fs').FSWatcher | null
  subagentsDir: string
}
