/**
 * Subagent file watching.
 *
 * Discovers each session's subagent JSONL files, identifies them by launch ID
 * (from their .meta.json), and tails them. Inline progress events for the same
 * subagent share its dedup state (see subagentDedupFor), so whichever source
 * delivers an entry first wins and the other skips it.
 */

import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SubagentLaunch, SubagentState, WatchedSession, spawnSubagentNode, subagentDedupFor } from './protocol'
import { SESSION_ID_DISPLAY, SUBAGENT_META_WAIT_MS, SUBAGENT_LAUNCH_WAIT_MS, INACTIVITY_TIMEOUT_MS, HIDDEN_TOOLS } from './constants'
import { readCompleteLines, readNewFileLines } from './fs-utils'
import { TranscriptParser, isConversationEntry, launchShape, launchedInBackground, taskNotificationLaunchId } from './transcript-parser'
import { createLogger } from './logger'

const log = createLogger('SubagentWatcher')

interface SubagentWatcherDelegate {
  emit(event: AgentEvent, sessionId: string): void
  elapsed(sessionId: string): number
  getSession(sessionId: string): WatchedSession | undefined
  /** A sub-agent of the session is working: keep the session active */
  touchSession(sessionId: string): void
}

/** `agent-<id>.jsonl` → `<id>`, the id the session's transcript gives a background agent */
function agentIdFromPath(jsonlPath: string): string {
  return path.basename(jsonlPath).replace(/^agent-/, '').replace(/\.jsonl$/, '')
}

/**
 * Read the launch ID a subagent's .meta.json sidecar gives it: the Agent tool_use that started
 * it, or, for a background agent the session started itself (Claude Code's /subtask, or a forked
 * skill such as /code-review, marked by its .forked-skill.json sidecar; neither has a launching
 * Agent call), the agent ID its file is named after.
 * `pending`: the sidecar doesn't exist yet (Claude Code writes the .jsonl a
 * moment before it). `none`: the sidecar has no launch ID (some Claude Code
 * versions/agent types), so the file can't be matched to a launch.
 */
export function readLaunchIdFromMeta(jsonlPath: string): { id: string; fork?: boolean } | 'pending' | 'none' {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  let raw: string
  try { raw = fs.readFileSync(metaPath, 'utf-8') } catch { return 'pending' }
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>
    if (typeof meta.toolUseId === 'string' && meta.toolUseId) return { id: meta.toolUseId }
    const forkedSkill = meta.isFork !== true && fs.existsSync(jsonlPath.replace(/\.jsonl$/, '.forked-skill.json'))
    return meta.isFork === true || forkedSkill ? { id: agentIdFromPath(jsonlPath), fork: true } : 'none'
  } catch { return 'pending' /* partially written */ }
}

/** Scan the subagents directory for new JSONL files and start tailing them */
export function scanSubagentsDir(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  // A closed session's sub-agents aren't tracked (see closeSession in relay.ts)
  if (session.sessionCompleted) return

  // Start watching the directory itself once it exists
  if (!session.subagentsDirWatcher && fs.existsSync(session.subagentsDir)) {
    try {
      session.subagentsDirWatcher = fs.watch(session.subagentsDir, () => {
        scanSubagentsDir(delegate, parser, sessionId)
      }).on('error', () => { /* dir removed; the poll loop rescans */ })
    } catch { /* dir may disappear; the poll loop rescans */ }
  }

  const subDir = session.subagentsDir
  if (!fs.existsSync(subDir)) return

  // Every new file is pre-scanned before any of them gets a node: a file can record the launch of
  // another (a fork's reviewers), and readdir order says nothing about which launched which, so a
  // nested agent read before its launcher would otherwise be drawn under the main agent
  const settles: Array<() => void> = []
  try {
    for (const file of fs.readdirSync(subDir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(subDir, file)
      if (session.subagentWatchers.has(filePath) || session.ignoredSubagentFiles.has(filePath)) continue
      const settle = startWatchingSubagentFile(delegate, parser, filePath, session)
      if (settle) settles.push(settle)
    }
  } catch { /* dir not readable yet */ }
  for (const settle of settles) settle()
}

/**
 * Start tailing a sub-agent file. A file found with history is pre-scanned here; what gives it its
 * node (and starts its watcher) is returned, to be run once the other files of the scan are
 * pre-scanned too (see scanSubagentsDir).
 */
function startWatchingSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  session: WatchedSession,
): (() => void) | undefined {
  const sessionId = session.sessionId

  // Identify the subagent by its launch ID. Wait a little for a missing sidecar;
  // give up on files that can never be matched so they aren't re-read forever.
  const meta = readLaunchIdFromMeta(filePath)
  if (meta === 'pending') {
    const firstSeen = session.subagentFilesAwaitingMeta.get(filePath) ?? Date.now()
    session.subagentFilesAwaitingMeta.set(filePath, firstSeen)
    if (Date.now() - firstSeen > SUBAGENT_META_WAIT_MS) {
      session.subagentFilesAwaitingMeta.delete(filePath)
      session.ignoredSubagentFiles.add(filePath)
    }
    return
  }
  session.subagentFilesAwaitingMeta.delete(filePath)
  if (meta === 'none') {
    session.ignoredSubagentFiles.add(filePath)
    return
  }

  const agentName = meta.id
  const launch = session.launches.get(agentName)
  // A sub-agent started since we attached, whose launch line isn't read yet:
  // wait for it, so the file is replayed as live rather than skipped as history
  // (the dir watcher, the poll, new transcript lines and launch hooks rescan)
  if (!launch && session.attachScanDone) {
    const firstSeen = session.subagentFilesAwaitingLaunch.get(filePath) ?? Date.now()
    session.subagentFilesAwaitingLaunch.set(filePath, firstSeen)
    if (Date.now() - firstSeen <= SUBAGENT_LAUNCH_WAIT_MS) return
  }
  session.subagentFilesAwaitingLaunch.delete(filePath)
  // Already finished: nothing more to show from it
  if (launch?.finished) {
    session.ignoredSubagentFiles.add(filePath)
    return
  }
  log.info(`Tailing subagent: ${path.basename(filePath)} (launch ${agentName}, session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    fileSize: 0,
    agentName,
    dedup: subagentDedupFor(session, agentName),
    watcher: null,
  }
  session.subagentWatchers.set(filePath, state)

  // A launch we saw live that is still running: replay its file from the start,
  // so tool calls made before we began tailing it (we wait for its .meta.json
  // and its launch line) are shown too. Anything else is only pre-scanned below.
  if (launch?.seenLive) {
    readSubagentNewLines(delegate, parser, filePath, sessionId)
    watchSubagentFile(delegate, parser, filePath, state, sessionId)
    return
  }

  // Pre-scan existing content: mark its tool calls seen, track the unanswered
  // ones (so their results still match), and record its own (nested) launches.
  // Calls the PreToolUse hook already showed are ended if their result is here.
  const pending = state.dedup.pendingToolCalls
  const shown = new Set(pending.keys())
  // A nested launch the file shows finished: if the PreToolUse hook already
  // gave it a node, that completes
  const finishNested = (id: string, launch: SubagentLaunch) => {
    const hadNode = session.spawnedSubagents.has(id)
    launch.finished = true
    session.spawnedSubagents.add(id)
    if (hadNode) delegate.emit({ time: delegate.elapsed(sessionId), type: 'agent_complete', payload: { name: id } }, sessionId)
  }
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 0) {
      const existing = readCompleteLines(filePath, 0, stat.size)
      for (const line of existing.lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line.trim()) as {
            message?: { content?: Array<{ type: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean }> }
            toolUseResult?: unknown
          }
          // One of its own background launches already reported back
          const notified = taskNotificationLaunchId(entry as Record<string, unknown>, session.launches)
          const notifiedLaunch = notified ? session.launches.get(notified) : undefined
          if (notified && notifiedLaunch?.background && !notifiedLaunch.finished) finishNested(notified, notifiedLaunch)
          // Only its conversation's own entries: request records (api-request-blob) repeat
          // calls long answered, which would otherwise be drawn as running forever
          if (!isConversationEntry(entry as Record<string, unknown>)) continue
          if (!entry?.message || !Array.isArray(entry.message.content)) continue
          for (const block of entry.message.content) {
            if (block.type === 'tool_use' && block.id && block.name) {
              state.dedup.seenToolUseIds.add(block.id)
              pending.set(block.id, { name: block.name })
              if ((block.name === 'Agent' || block.name === 'Task') && !session.launches.has(block.id)) {
                session.launches.set(block.id, { parent: agentName, seenLive: false, background: false, finished: false })
              }
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              const call = pending.get(block.tool_use_id)
              if (call && shown.has(block.tool_use_id) && call.name !== 'Agent' && call.name !== 'Task') {
                delegate.emit({
                  time: delegate.elapsed(sessionId),
                  type: 'tool_call_end',
                  payload: { agent: agentName, tool: call.name, id: block.tool_use_id, ...(block.is_error === true ? { isError: true } : {}) },
                }, sessionId)
              }
              pending.delete(block.tool_use_id)
              const nested = session.launches.get(block.tool_use_id)
              if (nested && !nested.finished) {
                if (launchedInBackground(entry.toolUseResult, block, () => launchShape(session, block.tool_use_id!))) nested.background = true
                else finishNested(block.tool_use_id, nested)
              }
            }
          }
        } catch { /* skip unparseable subagent transcript lines */ }
      }
      state.fileSize = existing.nextOffset
    }
  } catch { /* file not readable yet */ }

  return () => {
    // Its launch as the scan's other files recorded it (a parent sub-agent's pre-scan may have
    // recorded or finished it after this file was read)
    const known = session.launches.get(agentName)
    if (known?.finished) {
      stopTailing(session, filePath, state)
      return
    }
    // A subagent still running gets a node (unless the hook gave it one): one
    // whose launch we know and that isn't finished (recorded by a transcript's
    // pre-scan, the main one or a parent sub-agent's), or (for launches we don't
    // know) one with tool calls still pending. Its running tools get nodes too.
    // One whose file has long gone quiet is only tailed, and gets its node once
    // it does something again (one killed by a Claude Code restart never will).
    const recent = fileIdleMs(filePath) <= INACTIVITY_TIMEOUT_MS
    const running = recent && (!!known || pending.size > 0)
    if (running) {
      spawnSubagentNode(delegate, session, agentName)
      for (const [id, call] of pending) {
        if (call.name === 'Agent' || call.name === 'Task' || HIDDEN_TOOLS.has(call.name) || shown.has(id)) continue
        delegate.emit({
          time: delegate.elapsed(sessionId),
          type: 'tool_call_start',
          payload: { agent: agentName, tool: call.name, id },
        }, sessionId)
      }
    }

    watchSubagentFile(delegate, parser, filePath, state, sessionId)
  }
}

/** How long since a file was last written (ms); Infinity if it can't be read */
export function fileIdleMs(filePath: string, now = Date.now()): number {
  try { return now - fs.statSync(filePath).mtimeMs } catch { return Infinity }
}

/** Stop tailing a sub-agent's file for good */
export function stopTailing(session: WatchedSession, filePath: string, state: SubagentState): void {
  state.watcher?.close()
  session.subagentWatchers.delete(filePath)
  session.ignoredSubagentFiles.add(filePath)
}

function watchSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  state: SubagentState,
  sessionId: string,
): void {
  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    }).on('error', () => { /* file removed; the poll loop covers the rest */ })
  } catch { /* fs.watch unsupported; the poll loop covers it */ }
}

export function readSubagentNewLines(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  const state = session.subagentWatchers.get(filePath)
  if (!state) return

  // A finished launch has nothing more to show (later activity doesn't revive it)
  const launch = session.launches.get(state.agentName)
  if (launch?.finished) {
    stopTailing(session, filePath, state)
    return
  }

  const result = readNewFileLines(filePath, state.fileSize)
  if (!result) return
  state.fileSize = result.newSize

  // Lazily give it its node on first new content
  spawnSubagentNode(delegate, session, state.agentName)

  const { dedup } = state
  for (const line of result.lines) {
    parser.processTranscriptLine(line, state.agentName, dedup.pendingToolCalls, dedup.seenToolUseIds, sessionId, dedup.seenMessageHashes)
  }

  // Keep the session active while its sub-agents are working
  delegate.touchSession(sessionId)
}
