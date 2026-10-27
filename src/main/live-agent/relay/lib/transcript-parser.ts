/**
 * Parses Claude Code JSONL transcript lines and emits AgentEvents via a
 * delegate, keeping the parsing logic decoupled from file-watching concerns.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  AgentEvent, LaunchShape, PendingToolCall, WatchedSession,
  TranscriptEntry, ToolUseBlock, ToolResultBlock,
  spawnSubagentNode, subagentDedupFor,
} from './protocol'
import {
  HASH_PREFIX_MAX,
  HIDDEN_TOOLS,
  ORCHESTRATOR_NAME,
} from './constants'
import { createLogger } from './logger'

const log = createLogger('TranscriptParser')

interface TranscriptParserDelegate {
  emit(event: AgentEvent, sessionId: string): void
  elapsed(sessionId: string): number
  getSession(sessionId: string): WatchedSession | undefined
  /** Read whatever a sub-agent's transcript file has left, before it's finished */
  flushSubagent(sessionId: string, launchId: string): void
}

/** Type guard: check if a value is a non-null object */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** Safely extract trimmed text from a text block */
function safeText(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.text || '').trim()
}

/** Safely extract trimmed thinking content from a thinking block */
function safeThinking(block: unknown): string {
  if (!isRecord(block)) return ''
  return String(block.thinking || '').trim()
}

/** A thinking block's signature, if it has one. Used for blocks whose text is
 *  empty: redacted thinking (plaintext stripped, as Opus 4.7+ does). */
function redactedThinkingSignature(block: unknown): string | null {
  if (!isRecord(block)) return null
  const sig = block.signature
  return typeof sig === 'string' && sig.length > 0 ? sig : null
}

/** Build the dedup hash key for a thinking block. Prefers the transcript entry
 *  UUID; falls back to a prefix of the content (or signature, for redacted blocks). */
function thinkingHashKey(entryUuid: string | undefined, fallbackSource: string): string {
  return entryUuid
    ? `thinking:${entryUuid}`
    : `thinking:${fallbackSource.slice(0, HASH_PREFIX_MAX)}`
}

/** Whether the parent transcript records an Agent/Task launch as a background
 *  (async) launch, via the entry-level `toolUseResult` field of the user entry
 *  carrying its tool_result. */
function isAsyncLaunch(toolUseResult: unknown): boolean {
  if (!isRecord(toolUseResult)) return false
  return toolUseResult.status === 'async_launched' || toolUseResult.isAsync === true
}


/** The answer the Agent tool gives a background launch, for a result without a toolUseResult
 *  (see launchedInBackground) */
const ASYNC_LAUNCH_ANSWER = 'Async agent launched successfully'

/**
 * Whether an Agent/Task call's result says the agent goes on in the background: then it has only
 * started, and what ends it is its <task-notification>. Taken for its end instead, a background
 * agent a sub-agent launches (the reviewers /code-review's fork sends out) was drawn finished the
 * moment it was launched, and went on working unseen. The result itself comes first: its
 * toolUseResult, which a sub-agent's own transcript leaves out, then the answer's wording. Only a
 * result that says neither is settled by the `requestShape` in the launched agent's .meta.json
 * (`shape`, read only when needed): it is written once, when the call is made, so it still says
 * 'foreground' for an agent Claude Code moved to the background later (Ctrl+B, or on its own).
 * A call that failed launched nothing that will report, even where its .meta.json was already
 * written for the background.
 */
export function launchedInBackground(toolUseResult: unknown, block: unknown, shape?: () => LaunchShape | undefined): boolean {
  if (isRecord(block) && block.is_error === true) return false
  if (isAsyncLaunch(toolUseResult)) return true
  if (saysHowItRan(toolUseResult)) return false
  const content = isRecord(block) ? block.content : undefined
  const answer = typeof content === 'string' || Array.isArray(content)
    ? userContentText(content as TranscriptEntry['message']['content'])
    : ''
  if (answer.startsWith(ASYNC_LAUNCH_ANSWER)) return true
  return shape?.() === 'background'
}

/**
 * How the Agent/Task call `toolUseId` ran, by the `requestShape` its sub-agent's .meta.json records
 * (matched by its `toolUseId`), or undefined while that isn't written. A .meta.json is read until
 * it has both, and only when a result needs it.
 */
export function launchShape(session: WatchedSession, toolUseId: string): LaunchShape | undefined {
  const known = session.launchShapes.get(toolUseId)
  if (known) return known
  let files: string[]
  try { files = fs.readdirSync(session.subagentsDir) } catch { return undefined }
  for (const file of files) {
    if (!file.endsWith('.meta.json') || session.readLaunchMetas.has(file)) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(session.subagentsDir, file), 'utf-8')) as Record<string, unknown>
      // Done with it only once it says both: Claude Code writes a .meta.json more than once
      if (typeof meta.toolUseId === 'string' && (meta.requestShape === 'background' || meta.requestShape === 'foreground')) {
        session.launchShapes.set(meta.toolUseId, meta.requestShape)
        session.readLaunchMetas.add(file)
      }
    } catch { /* not written yet, or partially: read again next time */ }
  }
  return session.launchShapes.get(toolUseId)
}

/** A toolUseResult that states how the agent ran (its status, or whether it went to the background) */
function saysHowItRan(toolUseResult: unknown): boolean {
  return isRecord(toolUseResult) && !Array.isArray(toolUseResult)
    && (typeof toolUseResult.status === 'string' || typeof toolUseResult.isAsync === 'boolean')
}

const TASK_NOTIFICATION_PREFIX = '<task-notification'

/** Text of a user entry's content, whether a plain string or text blocks. */
function userContentText(content: TranscriptEntry['message']['content']): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(safeText).filter(Boolean).join('\n')
}

function xmlTag(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  if (!match) return undefined
  return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
}

/**
 * The launches a `<task-notification>` block (sent when a background task stops) may name: its
 * `tool-use-id` (an Agent/Task launch), then its `task-id` (a background agent the session
 * started itself: /subtask, which has no launching tool call, or a forked skill, whose
 * `tool-use-id` is its Skill call while its node is named by the agent id).
 */
function parseTaskNotification(text: string): string[] {
  if (!text.startsWith(TASK_NOTIFICATION_PREFIX)) return []
  return [xmlTag(text, 'tool-use-id'), xmlTag(text, 'task-id')].filter((id): id is string => !!id)
}

/**
 * The ids of the background task a transcript entry reports as stopped (see
 * parseTaskNotification). Claude Code records the notification in one of three ways: as a user
 * message when it starts a turn; or, when it arrives mid-turn, as a `queue-operation` enqueue
 * (written the moment the task stops) followed by a `queued_command` attachment (when the model
 * is handed it). Seeing it more than once is fine.
 */
function taskNotificationIds(entry: Record<string, unknown>): string[] {
  let text = ''
  if (entry.type === 'user' && isRecord(entry.message)) {
    text = userContentText(entry.message.content as TranscriptEntry['message']['content'])
  } else if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && typeof entry.content === 'string') {
    text = entry.content.trim()
  } else if (entry.type === 'attachment' && isRecord(entry.attachment) && entry.attachment.type === 'queued_command'
    && typeof entry.attachment.prompt === 'string') {
    text = entry.attachment.prompt.trim()
  }
  return text ? parseTaskNotification(text) : []
}

/** The tracked launch a transcript entry reports as stopped (a `<task-notification>`), if any */
export function taskNotificationLaunchId(entry: Record<string, unknown>, launches: ReadonlyMap<string, unknown>): string | undefined {
  return taskNotificationIds(entry).find(id => launches.has(id))
}

/**
 * The background agent a forked skill runs in (a skill with `context: fork`, e.g. /code-review),
 * from its Skill call's result: Claude Code writes its work to subagents/agent-<id>.jsonl, like a
 * /subtask fork's, and reports back with a <task-notification>. Undefined for any other result,
 * and for a forked skill run in the foreground (its result is its answer: it's already done).
 */
export function forkedSkillAgentId(toolUseResult: unknown): string | undefined {
  if (!isRecord(toolUseResult) || toolUseResult.status !== 'forked' || toolUseResult.background === false) return undefined
  return typeof toolUseResult.agentId === 'string' && toolUseResult.agentId ? toolUseResult.agentId : undefined
}

/** Whether a transcript entry is a message of the conversation. Other entries can carry message
 *  content too: Claude Code 2.1.300+ records each API request's messages as `api-request-blob`
 *  entries, written after the calls they hold were answered, so their tool_use blocks are
 *  history, never calls starting. */
export function isConversationEntry(entry: Record<string, unknown>): boolean {
  return entry.type === 'user' || entry.type === 'assistant'
}

/** User entries Claude Code writes for local slash commands (`/model`, …) and
 *  `!` shell commands: they don't reach the model, so the agent isn't working */
const LOCAL_COMMAND_PREFIXES = ['<command-name>', '<local-command-', '<bash-input>', '<bash-stdout>', '<bash-stderr>']
const INTERRUPT_PREFIX = '[Request interrupted by user'

/**
 * How a transcript entry affects the agent's turn:
 * - `end`: the turn is over. Claude Code writes `turn_duration` /
 *   `stop_hook_summary` system entries when a turn completes, and an
 *   "[Request interrupted by user…]" user entry when it's interrupted.
 * - `local`: a local command's entry, a meta entry (`isMeta`), or the summary a
 *   compaction writes; doesn't start a turn.
 * - `activity`: any other user/assistant message: the agent is working.
 */
function turnEffect(entry: Record<string, unknown>): 'end' | 'local' | 'activity' | null {
  if (entry.type === 'system') {
    return entry.subtype === 'turn_duration' || entry.subtype === 'stop_hook_summary' ? 'end' : null
  }
  if ((entry.type !== 'user' && entry.type !== 'assistant') || !isRecord(entry.message)) return null
  if (entry.type === 'user') {
    if (entry.isMeta === true || entry.isCompactSummary === true) return 'local'
    const text = userContentText(entry.message.content as TranscriptEntry['message']['content'])
    if (text.startsWith(INTERRUPT_PREFIX)) return 'end'
    if (LOCAL_COMMAND_PREFIXES.some(prefix => text.startsWith(prefix))) return 'local'
  }
  return 'activity'
}

/**
 * turnEffect, for an entry of this session. Claude Code 2.1.300+ delivers a
 * background sub-agent's report as a peer message (its SubagentHandback call),
 * which starts a turn, and writes the task's `<task-notification>` only after
 * that turn has ended; nothing answers it, so it doesn't start one. Every other
 * notification (all of them before 2.1.300) does, as the agent replies to it.
 */
function sessionTurnEffect(entry: Record<string, unknown>, session: WatchedSession): ReturnType<typeof turnEffect> {
  if (entry.type === 'user' && isRecord(entry.origin) && entry.origin.handback === true
      && typeof entry.origin.senderTaskId === 'string') {
    session.handedBackTasks.add(entry.origin.senderTaskId)
  }
  const turn = turnEffect(entry)
  if (turn !== 'activity' || entry.type !== 'user' || !isRecord(entry.message)) return turn
  const text = userContentText(entry.message.content as TranscriptEntry['message']['content'])
  const taskId = text.startsWith(TASK_NOTIFICATION_PREFIX) ? xmlTag(text, 'task-id') : undefined
  return taskId && session.handedBackTasks.has(taskId) ? 'local' : turn
}

/**
 * The background agent a line starts: Claude Code's /subtask runs the session's own agent in the
 * background instead of making an Agent tool call, and records it with an informational line
 * naming the agent it launched. Its work goes to subagents/agent-<id>.jsonl, like a sub-agent's,
 * and it reports back with a <task-notification>, like a background one.
 */
function backgroundAgentLaunchId(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'system') return undefined
  if (typeof entry.launchedAgentId === 'string' && entry.launchedAgentId) return entry.launchedAgentId
  return typedForkedSkillAgentId(entry)
}

/** The marker a forked skill typed as a command leaves in the command's output */
const FORKED_SKILL_LAUNCH = /<forked-skill-launch>(\{.*?\})<\/forked-skill-launch>/s

/**
 * The background agent a forked skill typed as a command runs in (`/code-review` at the prompt):
 * it runs like /subtask's, its work in subagents/agent-<id>.jsonl and its end a <task-notification>,
 * but Claude Code records its start only as a marker in the command's output. Called from a Skill
 * tool call instead, the same agent shows in the call's result (see forkedSkillAgentId). Without
 * its launch the agent is still drawn, from its sidecar, but its notification has nothing to finish
 * and it is left on the graph as still working.
 */
function typedForkedSkillAgentId(entry: Record<string, unknown>): string | undefined {
  if (entry.subtype !== 'local_command' || typeof entry.content !== 'string') return undefined
  const marker = FORKED_SKILL_LAUNCH.exec(entry.content)
  if (!marker) return undefined
  try {
    const launch = JSON.parse(marker[1]) as Record<string, unknown>
    return typeof launch.agentId === 'string' && launch.agentId ? launch.agentId : undefined
  } catch {
    return undefined
  }
}

/** Whether a transcript line is the agent working (a message, a tool call or
 *  result), as opposed to bookkeeping such as titles, queue entries or local commands */
export function isActivityLine(line: string): boolean {
  try {
    return turnEffect(JSON.parse(line.trim()) as Record<string, unknown>) === 'activity'
  } catch {
    return false
  }
}

/** A finished turn's unanswered tool calls were abandoned (e.g. interrupted);
 *  sub-agent launches keep running */
function dropAbandonedCalls(session: WatchedSession): void {
  for (const [id, call] of session.pendingToolCalls) {
    if (call.name !== 'Agent' && call.name !== 'Task') session.pendingToolCalls.delete(id)
  }
}

export class TranscriptParser {
  constructor(private delegate: TranscriptParserDelegate) {}

  /**
   * Process one transcript line for `agentName` (the orchestrator, or a sub-agent's
   * launch ID). `ctx*` are the dedup sets of whoever owns this transcript.
   */
  processTranscriptLine(
    line: string,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    ctxSeen: Set<string>,
    sessionId: string,
    ctxSeenMessages: Set<string>,
  ): void {
    const session = this.delegate.getSession(sessionId)
    if (!session) return

    let parsed: unknown
    try {
      parsed = JSON.parse(line.trim())
    } catch {
      return // skip unparseable line
    }
    if (!isRecord(parsed)) return // not an entry

    // A background agent the session started (/subtask) gets its node right away
    const launchedId = agentName === ORCHESTRATOR_NAME ? backgroundAgentLaunchId(parsed) : undefined
    if (launchedId && !session.launches.has(launchedId)) {
      session.launches.set(launchedId, { parent: ORCHESTRATOR_NAME, seenLive: true, background: true, fork: true, finished: false })
      spawnSubagentNode(this.delegate, session, launchedId)
    }

    // A background task finished. Only Agent/Task launches we're tracking are
    // acted on; background Bash and other tasks send the same block.
    const finishedLaunchId = taskNotificationLaunchId(parsed, session.launches)
    if (finishedLaunchId) this.handleTaskNotification(finishedLaunchId, session)

    const turn = sessionTurnEffect(parsed, session)
    if (turn === 'end') {
      if (agentName === ORCHESTRATOR_NAME) this.endTurn(session)
      return
    }
    if (turn === 'local') return
    if (turn === 'activity' && agentName === ORCHESTRATOR_NAME) session.turnOpen = true

    // Inline sub-agent progress events (written by some Claude Code versions)
    if (parsed.type === 'progress') {
      this.handleProgressEvent(parsed, session)
      return
    }

    // Only process actual conversation entries (user/assistant turns)
    if (parsed.type !== 'user' && parsed.type !== 'assistant') {
      return
    }

    const msg = parsed.message as TranscriptEntry['message'] | undefined
    if (!msg) { return }
    const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : undefined

    const role = msg.role // 'assistant', 'user', 'human'

    // Handle string content (user messages are often just strings)
    if (typeof msg.content === 'string' && msg.content.trim()) {
      if (role === 'user' || role === 'human') {
        const text = msg.content.trim()
        const hash = uuid ? `user:${uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`
        this.emitMessageOnce(hash, agentName, ctxSeenMessages, sessionId)
      }
      return
    }

    if (!Array.isArray(msg.content)) { return }

    // Determine the emitted role from the JSONL entry role
    const emitRole = (role === 'user' || role === 'human') ? 'user' : 'assistant'

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        const toolBlock = block as ToolUseBlock
        if (ctxSeen.has(toolBlock.id)) { continue }
        ctxSeen.add(toolBlock.id)
        this.handleToolUse(toolBlock, agentName, ctxPending, session)
      } else if (block.type === 'tool_result') {
        this.handleToolResult(block as ToolResultBlock, agentName, ctxPending, session, parsed.toolUseResult)
      } else if (block.type === 'text' && 'text' in block) {
        const text = safeText(block)
        if (text) {
          const hash = uuid ? `${emitRole}:${uuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`
          this.emitMessageOnce(hash, agentName, ctxSeenMessages, sessionId)
        }
      } else if (block.type === 'thinking' && 'thinking' in block) {
        // Redacted thinking (Opus 4.7+) has no text but a signature; it counts too
        const content = safeThinking(block) || redactedThinkingSignature(block)
        if (content) this.emitMessageOnce(thinkingHashKey(uuid, content), agentName, ctxSeenMessages, sessionId)
      }
    }
  }

  /** Emit a `message` event (the agent is thinking/talking) unless this message
   *  was already seen: a sub-agent's entries can arrive both from its own file
   *  and as inline progress events, and the attach-time pre-scan marks history */
  private emitMessageOnce(hash: string, agentName: string, seen: Set<string>, sessionId: string): void {
    if (seen.has(hash)) return
    seen.add(hash)
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'message',
      payload: { agent: agentName },
    }, sessionId)
  }

  private handleToolUse(
    block: ToolUseBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    session: WatchedSession,
  ): void {
    const sessionId = session.sessionId
    const toolName = block.name
    if (HIDDEN_TOOLS.has(toolName)) return

    ctxPending.set(block.id, { name: toolName })

    // A subagent launch (Task in older Claude Code, Agent in newer versions).
    // It's shown as the sub-agent's own node, not as a tool call.
    if (toolName === 'Task' || toolName === 'Agent') {
      // (a record made before its launch line was read, e.g. finished by its
      // SubagentStop meanwhile, is kept)
      if (!session.launches.has(block.id)) {
        session.launches.set(block.id, { parent: agentName, seenLive: true, background: false, finished: false })
      }
      // Once per launch (the file watcher may have already spawned it)
      spawnSubagentNode(this.delegate, session, block.id)
      return
    }

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_start',
      payload: { agent: agentName, tool: toolName, id: block.id },
    }, sessionId)
  }

  private handleToolResult(
    block: ToolResultBlock,
    agentName: string,
    ctxPending: Map<string, PendingToolCall>,
    session: WatchedSession,
    toolUseResult?: unknown,
  ): void {
    const sessionId = session.sessionId
    // A forked skill's agent gets its node, even when the PostToolUse hook already ended its call
    const forkedAgentId = forkedSkillAgentId(toolUseResult)
    if (forkedAgentId && !session.launches.has(forkedAgentId)) {
      session.launches.set(forkedAgentId, { parent: agentName, seenLive: true, background: true, fork: true, finished: false })
      spawnSubagentNode(this.delegate, session, forkedAgentId)
    }
    const pending = ctxPending.get(block.tool_use_id)
    // Skip results for calls we aren't tracking (e.g. abandoned when the turn ended, or ended by
    // the PostToolUse hook)
    if (!pending) { return }
    const toolName = pending.name

    ctxPending.delete(block.tool_use_id)
    if (HIDDEN_TOOLS.has(toolName)) return

    if (toolName === 'Task' || toolName === 'Agent') {
      const launch = session.launches.get(block.tool_use_id)
      if (launchedInBackground(toolUseResult, block, () => launchShape(session, block.tool_use_id))) {
        // Background launch: the subagent keeps running. It finishes when its
        // <task-notification> arrives (see handleTaskNotification).
        if (launch) launch.background = true
      } else {
        this.finishSubagent(block.tool_use_id, session)
      }
      return
    }

    const isError = block.is_error === true

    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'tool_call_end',
      payload: {
        agent: agentName,
        tool: toolName,
        id: block.tool_use_id,
        ...(isError ? { isError } : {}),
      },
    }, sessionId)
  }

  /** Whether a tool call the PreToolUse hook reports is new: not seen yet, in
   *  the main agent or a running sub-agent (see startToolFromHook) */
  isNewHookTool(session: WatchedSession, agentName: string, toolUseId: string): boolean {
    if (agentName === ORCHESTRATOR_NAME) return !session.seenToolUseIds.has(toolUseId)
    const launch = session.launches.get(agentName)
    if (!launch || launch.finished) return false
    return !session.subagentDedup.get(agentName)?.seenToolUseIds.has(toolUseId)
  }

  /**
   * A tool call (or sub-agent launch) reported by the PreToolUse hook as it
   * starts, ahead of the transcript entry. It's recorded like that entry would
   * be, so the entry is skipped when it arrives and the call's result still
   * completes it. Call it only for a new call (isNewHookTool): a call in a
   * sub-agent that isn't running (unknown, or finished) is left to the transcript.
   */
  startToolFromHook(session: WatchedSession, agentName: string, toolName: string, toolUseId: string): void {
    const isMain = agentName === ORCHESTRATOR_NAME
    if (!isMain) spawnSubagentNode(this.delegate, session, agentName)
    const dedup = isMain
      ? { pendingToolCalls: session.pendingToolCalls, seenToolUseIds: session.seenToolUseIds }
      : subagentDedupFor(session, agentName)
    dedup.seenToolUseIds.add(toolUseId)
    if (isMain) session.turnOpen = true
    this.handleToolUse({ type: 'tool_use', id: toolUseId, name: toolName }, agentName, dedup.pendingToolCalls, session)
  }

  /**
   * The main agent's turn is over (from the transcript, or the Stop hook):
   * complete it once, whichever signal comes first. Tool calls still unanswered
   * were abandoned (e.g. interrupted); sub-agent launches keep running.
   */
  endTurn(session: WatchedSession): void {
    if (!session.turnOpen) return
    session.turnOpen = false
    // Sub-agents it launched in the foreground and never heard back from were stopped with it
    // (interrupted, or the turn failed); background ones keep running
    for (const [id, launch] of session.launches) {
      if (launch.parent === ORCHESTRATOR_NAME && !launch.background && !launch.fork && session.pendingToolCalls.has(id)) {
        this.finishWithForegroundDescendants(id, session)
      }
    }
    dropAbandonedCalls(session)
    this.delegate.emit({
      time: this.delegate.elapsed(session.sessionId),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME },
    }, session.sessionId)
  }

  /** Finish a sub-agent stopped with its caller, and the sub-agents it was waiting on (launched
   *  in the foreground), deepest first */
  private finishWithForegroundDescendants(launchId: string, session: WatchedSession): void {
    for (const [id, launch] of session.launches) {
      if (launch.parent === launchId && !launch.background && !launch.fork && !launch.finished) {
        this.finishWithForegroundDescendants(id, session)
      }
    }
    this.finishSubagent(launchId, session)
  }

  /**
   * A tool call the PostToolUse / PostToolUseFailure hook reports as done: ended like its
   * transcript result would end it (which is then skipped), so a call whose result is written
   * late, or never (an agent stopped mid-call), doesn't stay running. Sub-agent launches are left
   * to the transcript, which tells a background launch from a finished one.
   */
  endToolFromHook(session: WatchedSession, agentName: string, toolUseId: string, isError: boolean): void {
    const pendingCalls = agentName === ORCHESTRATOR_NAME
      ? session.pendingToolCalls
      : session.subagentDedup.get(agentName)?.pendingToolCalls
    const call = pendingCalls?.get(toolUseId)
    if (!pendingCalls || !call || call.name === 'Agent' || call.name === 'Task') return
    this.handleToolResult({ type: 'tool_result', tool_use_id: toolUseId, ...(isError ? { is_error: true } : {}) },
      agentName, pendingCalls, session)
  }

  /** Mark a sub-agent launch finished and emit its completion */
  finishSubagent(launchId: string, session: WatchedSession): void {
    const launch = session.launches.get(launchId)
    if (!launch || launch.finished) return
    // Its file may not have been read up to the end yet (e.g. its last tool result)
    this.delegate.flushSubagent(session.sessionId, launchId)
    launch.finished = true
    session.spawnedSubagents.add(launchId) // never (re)gets a node, e.g. as a parent
    session.subagentDedup.delete(launchId)
    const sessionId = session.sessionId
    this.delegate.emit({
      time: this.delegate.elapsed(sessionId),
      type: 'agent_complete',
      payload: { name: launchId },
    }, sessionId)
  }

  private handleTaskNotification(toolUseId: string, session: WatchedSession): void {
    const launch = session.launches.get(toolUseId)
    if (launch?.background) this.finishSubagent(toolUseId, session)
  }

  /**
   * Handle inline progress events, which some Claude Code versions write.
   * These carry subagent transcript entries directly in the main JSONL,
   * keyed by parentToolUseID (the Agent tool_use that spawned the subagent).
   * They share dedup state with the sub-agent's own transcript file.
   */
  private handleProgressEvent(parsed: Record<string, unknown>, session: WatchedSession): void {
    const data = parsed.data
    if (!isRecord(data) || data.type !== 'agent_progress') { return }

    const innerEntry = data.message as TranscriptEntry | undefined
    if (!innerEntry?.message) { return }

    const launchId = typeof parsed.parentToolUseID === 'string' ? parsed.parentToolUseID : undefined
    if (!launchId || session.launches.get(launchId)?.finished) { return }

    const dedup = subagentDedupFor(session, launchId)
    this.processTranscriptLine(JSON.stringify(innerEntry), launchId, dedup.pendingToolCalls, dedup.seenToolUseIds, session.sessionId, dedup.seenMessageHashes)
  }

  /**
   * Pre-scan existing file content so attaching to a session doesn't re-emit
   * its history: fills the tool_use and message dedup sets, tracks pending tool
   * calls, and records sub-agent launches (finished ones are marked as spawned,
   * so only sub-agents still running get a node). Sets whether the main agent's
   * turn is still open.
   */
  prescanExistingContent(lines: string[], session: WatchedSession): void {
    // No turn until a message starts one (a file may hold only local commands)
    let turnEnded = true
    for (const line of lines) {
      if (!line.trim()) { continue }
      try {
        const raw = JSON.parse(line.trim()) as Record<string, unknown>
        // A turn is over at its end marker, until the next message starts another
        const turn = sessionTurnEffect(raw, session)
        if (turn === 'end') { turnEnded = true; dropAbandonedCalls(session) }
        else if (turn === 'activity') turnEnded = false
        const entry = raw as unknown as TranscriptEntry & { toolUseResult?: unknown }
        // A background agent the session started before we attached
        const launchedId = backgroundAgentLaunchId(raw)
        if (launchedId && !session.launches.has(launchedId)) {
          session.launches.set(launchedId, { parent: ORCHESTRATOR_NAME, seenLive: false, background: true, fork: true, finished: false })
        }
        // A background sub-agent that already sent its <task-notification> is finished
        const finishedLaunchId = taskNotificationLaunchId(raw, session.launches)
        const finishedLaunch = finishedLaunchId && session.launches.get(finishedLaunchId)
        if (finishedLaunch && finishedLaunch.background) finishedLaunch.finished = true
        // A forked skill's agent started before we attached
        const forkedAgentId = isConversationEntry(raw) ? forkedSkillAgentId(entry.toolUseResult) : undefined
        if (forkedAgentId && !session.launches.has(forkedAgentId)) {
          session.launches.set(forkedAgentId, { parent: ORCHESTRATOR_NAME, seenLive: false, background: true, fork: true, finished: false })
        }
        const isUser = entry.message?.role === 'user' || entry.message?.role === 'human'
        // Only the conversation's own entries: request records repeat calls long answered
        if (isConversationEntry(raw) && entry.message && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use' && (block as ToolUseBlock).id) {
              const toolBlock = block as ToolUseBlock
              session.seenToolUseIds.add(toolBlock.id)
              if (toolBlock.name === 'Agent' || toolBlock.name === 'Task') {
                session.launches.set(toolBlock.id, { parent: ORCHESTRATOR_NAME, seenLive: false, background: false, finished: false })
              }
              // Track pending tool calls so handleToolResult works for calls made before we attached
              session.pendingToolCalls.set(toolBlock.id, { name: toolBlock.name })
            } else if (block.type === 'tool_result') {
              const resultBlock = block as ToolResultBlock
              const launch = session.launches.get(resultBlock.tool_use_id)
              if (launch) {
                if (launchedInBackground(entry.toolUseResult, resultBlock, () => launchShape(session, resultBlock.tool_use_id))) launch.background = true
                else launch.finished = true
              }
              session.pendingToolCalls.delete(resultBlock.tool_use_id)
            } else if (block.type === 'text' && 'text' in block) {
              const text = safeText(block)
              if (text) {
                const emitRole = isUser ? 'user' : 'assistant'
                session.seenMessageHashes.add(entry.uuid ? `${emitRole}:${entry.uuid}` : `${emitRole}:${text.slice(0, HASH_PREFIX_MAX)}`)
              }
            } else if (block.type === 'thinking' && 'thinking' in block) {
              const content = safeThinking(block) || redactedThinkingSignature(block)
              if (content) session.seenMessageHashes.add(thinkingHashKey(entry.uuid, content))
            }
          }
        } else if (entry.type === 'user' && typeof entry.message?.content === 'string') {
          const text = entry.message.content.trim()
          if (text) {
            session.seenMessageHashes.add(entry.uuid ? `user:${entry.uuid}` : `user:${text.slice(0, HASH_PREFIX_MAX)}`)
          }
        }
      } catch { /* skip unparseable transcript line */ }
    }
    for (const [id, launch] of session.launches) {
      if (launch.finished) session.spawnedSubagents.add(id)
    }
    log.info(`Pre-scanned ${session.seenToolUseIds.size} existing tool_use IDs`)
    session.turnOpen = !turnEnded
  }
}
