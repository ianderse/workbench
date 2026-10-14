import { useEffect, useState, useCallback, useRef } from 'react'
import type { AgentEvent, SessionInfo } from '../lib/relay-types'
import type { GraphEvent } from '../lib/agent-types'

/** Events kept per session (matches the relay's own buffer) */
const MAX_SESSION_EVENTS = 5000
/** Sessions whose events are kept, besides the one shown */
const MAX_BUFFERED_SESSIONS = 10

/** A session's buffered events. `base` counts events trimmed off the front, so
 *  positions stay absolute (event N is events[N - base]) across trims. */
interface SessionBuffer {
  /** Events carried over from the trimmed part (see carriedOver); they precede `events` */
  prelude: GraphEvent[]
  events: GraphEvent[]
  base: number
  lastEventAt: number
}

/**
 * The events from a trimmed history that the rest still depends on, so later
 * events still have nodes to apply to: the spawn of every agent still around
 * after them (and of its ancestors, so it keeps its place in the tree), the
 * start of every tool call still running, and the completion of each kept
 * agent that had finished. The main agent is always kept.
 * (The relay trims its buffer the same way: relay/relay.ts.)
 */
function carriedOver(events: GraphEvent[]): GraphEvent[] {
  const spawns = new Map<string, GraphEvent>()
  const completions = new Map<string, GraphEvent>()
  const runningTools = new Map<string, GraphEvent>()
  for (const event of events) {
    const name = String(event.payload.name ?? event.payload.agent ?? '')
    switch (event.type) {
      case 'agent_spawn':
        // A finished sub-agent isn't revived (only the main agent comes back), as the graph does
        if (completions.has(name) && !spawns.get(name)?.payload.isMain) break
        spawns.set(name, event)
        completions.delete(name)
        break
      case 'agent_complete':
        for (const id of event.payload.endsSession ? spawns.keys() : [name]) completions.set(id, event)
        for (const [toolId, tool] of runningTools) {
          if (event.payload.endsSession || tool.payload.agent === name) runningTools.delete(toolId)
        }
        break
      case 'message':
      case 'tool_call_start':
        // Ignored for a finished sub-agent (only the main agent comes back), as the graph does
        if (completions.has(name) && !spawns.get(name)?.payload.isMain) break
        completions.delete(name)
        if (event.type === 'tool_call_start') runningTools.set(String(event.payload.id), event)
        break
      case 'tool_call_end':
        runningTools.delete(String(event.payload.id))
        break
    }
  }
  // Keep the live agents, the main agent, and the ancestors of all of them
  const keep = new Set<string>()
  const keepWithAncestors = (id: string | undefined) => {
    while (id && !keep.has(id) && spawns.has(id)) {
      keep.add(id)
      id = spawns.get(id)!.payload.parent as string | undefined
    }
  }
  for (const [id, spawn] of spawns) {
    if (!completions.has(id) || spawn.payload.isMain) keepWithAncestors(id)
  }
  return [
    ...[...spawns].filter(([id]) => keep.has(id)).map(([, spawn]) => spawn),
    ...[...runningTools.values()].filter(tool => keep.has(String(tool.payload.agent))),
    // One event can complete several agents (endsSession): include it once
    ...new Set([...completions].filter(([id]) => keep.has(id)).map(([, completion]) => completion)),
  ]
}

const sameEvent = (a: GraphEvent | undefined, b: GraphEvent | undefined) =>
  a === b || (!!a && !!b && a.type === b.type && a.time === b.time && JSON.stringify(a.payload) === JSON.stringify(b.payload))

interface RelayHookResult {
  /** Events received from the relay for the shown session, not yet applied to the graph */
  pendingEvents: readonly GraphEvent[]
  /** Called by the graph once it has taken pendingEvents (they're then cleared) */
  consumeEvents: () => void
  /** Whether to play the mock scenario (demo mode) instead of relay events */
  useMockData: boolean
  /** Session currently shown, picked automatically: the newest to start (on
   *  connect, the one already shown if the relay still has it, else the active
   *  one with the latest activity) */
  shownSessionId: string | null
  /** Bumped whenever the graph must reload the shown session from the buffers:
   *  the session changed, or its history was replaced (e.g. after a reconnect) */
  viewVersion: number
  /** Whether a session's history was replaced since this was last asked (clears the flag) */
  takeHistoryReplaced: (sessionId: string) => boolean
  /** Queue a session's events from absolute position `from` (0 = its whole
   *  history). Call from the useLayoutEffect that swaps the graph state.
   *  Returns false, queueing nothing, if events after `from` were already
   *  trimmed: the graph must then be rebuilt from 0. */
  flushSessionEvents: (sessionId: string, from: number) => boolean
  /** How many of a session's events have been applied to the graph (absolute) */
  getSessionEventCount: (sessionId: string) => number
}

const toGraphEvent = (event: AgentEvent): GraphEvent => ({
  time: event.time,
  type: event.type as GraphEvent['type'],
  payload: event.payload,
})

/**
 * Connects the graph to the relay (a worker in the main process, see
 * src/main/live-agent), which sends the messages agent-flow's SSE stream did,
 * for the Claude Code sessions run in `cwd` (the agent window's directory).
 *
 * Shows one session at a time: on connect the one already shown if the relay
 * still has it, else the active one with the latest activity; then whichever
 * session starts next. Events are buffered per session so switching
 * replays the correct event history. The relay's history batches are
 * authoritative: one that differs from what we have replaces that session's
 * buffer, so a reconnect or a resend never duplicates events.
 */
export function useRelay(cwd: string): RelayHookResult {
  // Agent windows only show live sessions (agent-flow's demo scenario is off)
  const useMockData = false
  const pendingEventsRef = useRef<GraphEvent[]>([])

  const [shownSessionId, setShownSessionId] = useState<string | null>(null)
  const [viewVersion, setViewVersion] = useState(0)
  /** Updated synchronously (not via React state) so event handlers always see the current session */
  const shownSessionIdRef = useRef<string | null>(null)
  const buffersRef = useRef<Map<string, SessionBuffer>>(new Map())
  /** Absolute number of each session's events applied to the graph */
  const appliedRef = useRef<Map<string, number>>(new Map())
  /** Sessions whose history was replaced since the graph last loaded them */
  const historyReplacedRef = useRef<Set<string>>(new Set())
  /** True while a session switch or a rebuild of the shown session is pending
   *  (until the consumer flushes after swapping the graph state). Holds back
   *  live events meanwhile. */
  const sessionSwitchPendingRef = useRef(false)
  /** How many prelude events lead pendingEvents (they don't count as applied events) */
  const pendingPreludeRef = useRef(0)
  /** After a flush: the absolute position of the first queued (non-prelude)
   *  event. The applied count only moves once the graph has applied them. */
  const pendingStartRef = useRef<number | null>(null)

  /** Show another session. Does NOT flush events — the consumer calls
   *  flushSessionEvents from the useLayoutEffect that swaps the graph state. */
  const switchTo = useCallback((sessionId: string) => {
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    pendingPreludeRef.current = 0
    pendingStartRef.current = null
    shownSessionIdRef.current = sessionId
    setShownSessionId(sessionId)
    setViewVersion(v => v + 1)
  }, [])

  useEffect(() => {
    if (useMockData) return

    const bufferFor = (sessionId: string): SessionBuffer => {
      let buf = buffersRef.current.get(sessionId)
      if (!buf) {
        buf = { prelude: [], events: [], base: 0, lastEventAt: Date.now() }
        buffersRef.current.set(sessionId, buf)
        dropOldSessions()
      }
      return buf
    }

    // Keep only the most recently active sessions (always keeping the shown one)
    const dropOldSessions = () => {
      const buffers = buffersRef.current
      if (buffers.size <= MAX_BUFFERED_SESSIONS + 1) return
      const oldest = [...buffers.entries()]
        .filter(([id]) => id !== shownSessionIdRef.current)
        .sort((a, b) => a[1].lastEventAt - b[1].lastEventAt)
      for (const [id] of oldest.slice(0, buffers.size - (MAX_BUFFERED_SESSIONS + 1))) {
        buffers.delete(id)
        appliedRef.current.delete(id)
        historyReplacedRef.current.add(id) // any cached graph for it is now incomplete
      }
    }

    // Hold live delivery until the consumer rebuilds the shown session's graph
    // from its buffer (the session is marked replaced first)
    const rebuildShown = () => {
      sessionSwitchPendingRef.current = true
      pendingEventsRef.current.length = 0
      pendingPreludeRef.current = 0
      pendingStartRef.current = null
      setViewVersion(v => v + 1)
    }

    const handleEvent = (event: AgentEvent) => {
      const sessionId = event.sessionId
      if (!sessionId) return
      const graphEvent = toGraphEvent(event)

      const buf = bufferFor(sessionId)
      buf.events.push(graphEvent)
      buf.lastEventAt = Date.now()
      if (buf.events.length > MAX_SESSION_EVENTS * 1.1) {
        const trimmed = buf.events.splice(0, buf.events.length - MAX_SESSION_EVENTS)
        buf.prelude = carriedOver([...buf.prelude, ...trimmed])
        buf.base += trimmed.length
      }

      // Deliver live if it's for the shown session and no switch or rebuild is
      // pending (otherwise the consumer flushes it from the buffer after the swap)
      if (sessionId === shownSessionIdRef.current && !sessionSwitchPendingRef.current) {
        pendingEventsRef.current.push(graphEvent)
        // Not being taken (animation frames pause in a background tab): rather
        // than queue without limit, rebuild from the trimmed buffer later. Twice
        // the buffer size, since a rebuild itself queues up to the whole buffer.
        if (pendingEventsRef.current.length > MAX_SESSION_EVENTS * 2) {
          historyReplacedRef.current.add(sessionId)
          rebuildShown()
        }
      }
    }

    // A session's history (its last `events`, of `total` so far, after `prelude`).
    // Already have exactly that (sent on connect, attach and resume): nothing to do.
    // Otherwise it replaces whatever we had for the session.
    const handleHistory = (sessionId: string, prelude: AgentEvent[], events: AgentEvent[], total: number) => {
      const current = buffersRef.current.get(sessionId)
      const last = events.length ? toGraphEvent(events[events.length - 1]) : undefined
      if (current && current.base + current.events.length === total
        && sameEvent(current.events[current.events.length - 1], last)) return

      buffersRef.current.set(sessionId, {
        prelude: prelude.map(toGraphEvent), events: events.map(toGraphEvent),
        base: total - events.length, lastEventAt: Date.now(),
      })
      appliedRef.current.set(sessionId, 0)
      historyReplacedRef.current.add(sessionId)
      dropOldSessions()
      if (sessionId === shownSessionIdRef.current) rebuildShown()
    }

    // On connect, keep the shown session if the relay still has it; otherwise
    // show the active session with the latest activity
    const handleSessionList = (sessionList: SessionInfo[]) => {
      if (sessionList.length === 0) return
      if (sessionList.some(s => s.id === shownSessionIdRef.current)) return
      const sorted = [...sessionList].sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0
        const bActive = b.status === 'active' ? 1 : 0
        if (aActive !== bActive) return bActive - aActive
        return b.lastActivityTime - a.lastActivityTime
      })
      switchTo(sorted[0].id)
    }

    // Follow whichever session starts (or resumes after inactivity)
    const handleSessionStarted = (session: SessionInfo) => {
      if (session.id !== shownSessionIdRef.current) switchTo(session.id)
    }

    const clientId = crypto.randomUUID()
    const removeListener = window.electronAPI.onLiveAgentMessage((targetId, message) => {
      if (targetId !== clientId) return
      let data: any
      try { data = JSON.parse(message) } catch { return }
      if (!data || typeof data.type !== 'string') return

      switch (data.type) {
        case 'agent-event':
          handleEvent(data.event)
          break
        case 'agent-event-batch':
          if (typeof data.sessionId === 'string' && Array.isArray(data.events)) {
            const events: AgentEvent[] = data.events
            const prelude: AgentEvent[] = Array.isArray(data.prelude) ? data.prelude : []
            handleHistory(data.sessionId, prelude, events, typeof data.total === 'number' ? data.total : events.length)
          }
          break
        case 'session-list':
          handleSessionList(data.sessions)
          break
        case 'session-started':
          handleSessionStarted(data.session)
          break
      }
    })
    void window.electronAPI.subscribeLiveAgent(clientId, cwd)

    return () => {
      removeListener()
      void window.electronAPI.unsubscribeLiveAgent(clientId)
    }
  }, [useMockData, switchTo, cwd])

  const consumeEvents = useCallback(() => {
    const shown = shownSessionIdRef.current
    if (shown) {
      const applied = pendingEventsRef.current.length - pendingPreludeRef.current
      const start = pendingStartRef.current ?? appliedRef.current.get(shown) ?? 0
      appliedRef.current.set(shown, start + applied)
    }
    pendingPreludeRef.current = 0
    pendingStartRef.current = null
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  const flushSessionEvents = useCallback((sessionId: string, from: number): boolean => {
    const buf = buffersRef.current.get(sessionId)
    const base = buf?.base ?? 0
    // Resuming a graph from before the trimmed part would skip events
    if (from > 0 && from < base) return false
    sessionSwitchPendingRef.current = false
    pendingEventsRef.current.length = 0
    pendingPreludeRef.current = 0
    if (buf) {
      // A full rebuild starts with what the trimmed part left behind
      if (from === 0) {
        pendingEventsRef.current.push(...buf.prelude)
        pendingPreludeRef.current = buf.prelude.length
      }
      pendingEventsRef.current.push(...buf.events.slice(Math.max(0, from - base)))
    }
    // The graph is at `from` until it applies what's queued (a switch before
    // then caches it as such, and a rebuild from 0 replays the prelude too)
    appliedRef.current.set(sessionId, from)
    pendingStartRef.current = Math.max(from, base)
    return true
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return appliedRef.current.get(sessionId) ?? 0
  }, [])

  const takeHistoryReplaced = useCallback((sessionId: string): boolean => {
    return historyReplacedRef.current.delete(sessionId)
  }, [])

  return {
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    shownSessionId,
    viewVersion,
    takeHistoryReplaced,
    flushSessionEvents,
    getSessionEventCount,
  }
}
