import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { useTranslation } from 'react-i18next'
import { useGraphState } from './hooks/use-graph-state'
import { useRelay } from './hooks/use-relay'
import { useLiveAgentStatus } from './hooks/use-live-agent-status'
import { AgentCanvas } from "./agent-visualizer/canvas"
import { useTerminalStore } from '../../stores/terminal-store'
import { TIMING } from './lib/agent-types'

/** Graph snapshots kept for sessions that aren't shown */
const MAX_CACHED_SESSIONS = 10

interface LiveAgentGraphProps {
  /** The agent window's working directory: the graph shows the Claude Code sessions run in it */
  cwd: string
  /** The window's project (its .workbench/flow directory is where the relay advertises itself) */
  projectPath: string
  /** The window's terminal: of the sessions in `cwd`, the graph shows the ones run in it */
  terminalId: string
}

/**
 * Live agent graph: agent-flow's visualizer of a Claude Code session, shown
 * next to an agent window's terminal (Settings > Claude Code > Live agent).
 * From agent-flow (web/components/agent-visualizer/index.tsx).
 */
export default function LiveAgentGraph({ cwd, projectPath, terminalId }: LiveAgentGraphProps) {
  const { t } = useTranslation('terminal')
  const status = useLiveAgentStatus()
  // The window's spinner covers the graph as well as the terminal, so the main
  // agent waits behind it rather than resting through a start nobody can see
  const starting = useTerminalStore((state) => !!state.terminals.find((t) => t.id === terminalId)?.loading)
  const relay = useRelay(cwd, projectPath, terminalId)
  // Set while events queued at a session swap or rebuild wait to be applied
  // (the canvas holds its effects back until then)
  const historyQueuedRef = useRef(false)
  const { consumeEvents } = relay
  const onEventsConsumed = useCallback(() => {
    consumeEvents()
    historyQueuedRef.current = false
  }, [consumeEvents])

  const {
    graphRef,
    hasAgents,
    play,
    restart,
    saveSnapshot,
    restoreSnapshot,
  } = useGraphState({
    useMockData: relay.useMockData,
    externalEvents: relay.pendingEvents,
    onExternalEventsConsumed: onEventsConsumed,
  })

  // Auto-play on mount
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Per-session state cache: save/restore graph state when the shown session
  // changes, so each session stays up to date and switching is instant. A
  // session whose history was replaced is rebuilt from scratch instead.
  // useLayoutEffect ensures the swap happens synchronously before any animation
  // frame can consume and discard the relay's pending events.
  const sessionCacheRef = useRef<Map<string, { snapshot: ReturnType<typeof saveSnapshot>; eventCount: number }>>(new Map())
  const prevShownRef = useRef<string | null>(null)
  const { shownSessionId, viewVersion, pendingEvents, takeHistoryReplaced, flushSessionEvents, getSessionEventCount } = relay
  useLayoutEffect(() => {
    const cache = sessionCacheRef.current
    const prev = prevShownRef.current
    if (!shownSessionId) {
      // None of the window's sessions to show (the one shown runs in another
      // window): keep the outgoing one's graph and start empty
      if (prev !== null) {
        cache.delete(prev)
        cache.set(prev, { snapshot: saveSnapshot(), eventCount: getSessionEventCount(prev) })
        while (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value!)
        restart()
        prevShownRef.current = null
      }
      return
    }
    const replaced = takeHistoryReplaced(shownSessionId)

    if (shownSessionId === prev) {
      // Same session: rebuild if its history was replaced, else just resume
      // delivery from where the graph left off
      if (replaced || !flushSessionEvents(shownSessionId, getSessionEventCount(shownSessionId))) {
        restart()
        flushSessionEvents(shownSessionId, 0)
      }
      historyQueuedRef.current = pendingEvents.length > 0
      return
    }

    // Save the outgoing session (most recent last; drop the oldest beyond the cap)
    if (prev !== null) {
      cache.delete(prev)
      cache.set(prev, { snapshot: saveSnapshot(), eventCount: getSessionEventCount(prev) })
      while (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value!)
    }

    // Restore or cold-start the incoming session and queue its events. Both
    // happen HERE, in one layout effect, so no animation frame can process
    // events in the wrong graph context.
    const cached = replaced ? undefined : cache.get(shownSessionId)
    cache.delete(shownSessionId)
    if (cached && flushSessionEvents(shownSessionId, cached.eventCount)) {
      restoreSnapshot(cached.snapshot)
    } else {
      restart()
      flushSessionEvents(shownSessionId, 0)
    }
    historyQueuedRef.current = pendingEvents.length > 0
    prevShownRef.current = shownSessionId
  }, [shownSessionId, viewVersion, takeHistoryReplaced, flushSessionEvents, getSessionEventCount, restart, saveSnapshot, restoreSnapshot])

  const isEmpty = !hasAgents && !relay.useMockData

  // The relay's state when it isn't running yet, else what the graph is waiting for
  const notice = status?.state === 'error'
    ? { title: t('liveAgent.failed'), description: status.error }
    : status?.state !== 'running'
      ? { title: t('liveAgent.starting'), description: undefined }
      : { title: t('liveAgent.waitingTitle'), description: t('liveAgent.waitingDescription') }

  return (
    // No background of its own: the agent window's (bg-sidebar, the terminal's too) shows through,
    // so the terminal and the graph read as one piece
    <div className="h-full w-full relative overflow-hidden" aria-label={t('liveAgent.graphLabel')}>
      {/* A faint grid behind everything, fading out into the window (the website's hero stage) */}
      <div className="live-agent-grid absolute inset-0 pointer-events-none" aria-hidden="true" />

      {/* Empty state when no live data */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none px-4">
          <div className="text-center">
            <div className="text-sm text-muted-foreground">{notice.title}</div>
            {notice.description && (
              <div className="mt-1 text-xs text-muted-foreground/70 break-words">{notice.description}</div>
            )}
          </div>
        </div>
      )}

      {/* Canvas fills everything */}
      <AgentCanvas
        graphRef={graphRef}
        viewKey={`${shownSessionId}:${viewVersion}`}
        sessionKey={shownSessionId ?? ''}
        historyQueuedRef={historyQueuedRef}
        suspended={starting}
      />
    </div>
  )
}
