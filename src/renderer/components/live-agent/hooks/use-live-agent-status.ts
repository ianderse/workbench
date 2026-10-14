import { useEffect, useState } from 'react'
import type { LiveAgentStatus } from '../../../../shared/types'

/**
 * The relay's status (stopped, starting, running, failed). Asked once, then
 * kept up to date from the main process's status events, so graphs that open
 * later show the stored value without asking again.
 */
let current: LiveAgentStatus | null = null
const listeners = new Set<(status: LiveAgentStatus) => void>()
let started = false

function startTracking() {
  if (started) return
  started = true
  const update = (status: LiveAgentStatus) => {
    current = status
    for (const listener of listeners) listener(status)
  }
  window.electronAPI.onLiveAgentStatus(update)
  window.electronAPI.getLiveAgentStatus().then(result => {
    // A status event that arrived meanwhile is newer
    if (result.success && result.data && !current) update(result.data)
  }).catch(() => { /* shown as starting until an event arrives */ })
}

export function useLiveAgentStatus(): LiveAgentStatus | null {
  const [status, setStatus] = useState(current)
  useEffect(() => {
    startTracking()
    listeners.add(setStatus)
    setStatus(current)
    return () => { listeners.delete(setStatus) }
  }, [])
  return status
}
