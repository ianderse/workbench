import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useGraphState } from './hooks/use-graph-state'
import { AgentCanvas } from './agent-visualizer/canvas'
import { TIMING, type GraphEvent } from './lib/agent-types'
import { MASTER_ID, useLiveAgentSimulatorStore, type SimNode } from '../../stores/live-agent-simulator-store'

interface LiveAgentPreviewProps {
  /** The theme the box and the graph are drawn in, whatever the app's */
  theme: 'dark' | 'light'
}

/** The events the relay would send for a node appearing: a sub-agent, a subtask (a satellite
 *  session, drawn as a sub-agent with a square border) or a tool call that keeps running */
function addEvent(node: SimNode): GraphEvent {
  return node.kind === 'tool'
    ? { time: 0, type: 'tool_call_start', payload: { agent: node.parentId, tool: node.tool, id: node.id } }
    : { time: 0, type: 'agent_spawn', payload: { name: node.id, parent: node.parentId, satellite: node.kind === 'subtask' } }
}

/** …and for it going: the tool call ends, the agent completes; both then fade as they do live */
function removeEvent(node: SimNode): GraphEvent {
  return node.kind === 'tool'
    ? { time: 0, type: 'tool_call_end', payload: { agent: node.parentId, tool: node.tool, id: node.id } }
    : { time: 0, type: 'agent_complete', payload: { name: node.id } }
}

/**
 * The live agent graph of the simulator's tree (live-agent-simulator-store), in a square box
 * with an agent window's background, in a fixed theme: the master node, and whatever the
 * developer adds under it. Development builds only: the simulation page in Settings shows one
 * dark and one light side by side.
 */
export default function LiveAgentPreview({ theme }: LiveAgentPreviewProps) {
  const { t } = useTranslation('terminal')
  const historyQueuedRef = useRef(false)
  // Events waiting for the graph's next frame; the graph empties the array once it has them
  const pendingRef = useRef<GraphEvent[]>([{ time: 0, type: 'agent_spawn', payload: { name: MASTER_ID, isMain: true } }])
  const consumed = useCallback(() => { pendingRef.current.length = 0 }, [])
  const { graphRef, play } = useGraphState({
    useMockData: false,
    externalEvents: pendingRef.current,
    onExternalEventsConsumed: consumed,
  })

  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Turn each change to the tree into events: new nodes in the order they were added (parents
  // first), then the ones removed
  const nodes = useLiveAgentSimulatorStore((state) => state.nodes)
  const shownRef = useRef(new Map<string, SimNode>())
  useEffect(() => {
    const shown = shownRef.current
    const ids = new Set(nodes.map((node) => node.id))
    for (const node of nodes) {
      if (shown.has(node.id)) continue
      shown.set(node.id, node)
      pendingRef.current.push(addEvent(node))
    }
    for (const [id, node] of shown) {
      if (ids.has(id)) continue
      shown.delete(id)
      pendingRef.current.push(removeEvent(node))
    }
  }, [nodes])

  return (
    <div
      className={`${theme} relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-sidebar`}
      aria-label={t('liveAgent.graphLabel')}
    >
      <div className="live-agent-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <AgentCanvas
        graphRef={graphRef}
        viewKey="preview"
        sessionKey="preview"
        historyQueuedRef={historyQueuedRef}
        theme={theme}
      />
    </div>
  )
}
