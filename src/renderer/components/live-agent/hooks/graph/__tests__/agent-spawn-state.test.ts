import { describe, it, expect } from 'vitest'
import type { GraphEvent } from '../../../lib/agent-types'
import { createEmptyState, type GraphState } from '../types'
import { processEvent } from '../process-event'

const spawn = (name: string, parent?: string, isMain = false, satellite = false): GraphEvent => ({
  time: 0,
  type: 'agent_spawn',
  payload: { name, isMain, ...(parent ? { parent } : {}), ...(satellite ? { satellite } : {}) },
})

function play(events: GraphEvent[]): GraphState {
  return events.reduce((state, event) => processEvent(event, state), createEmptyState())
}

describe('a newly spawned agent', () => {
  it('is working from the start when it is a sub-agent, before it has said anything', () => {
    // A fork takes the whole conversation along and is a while starting: it must not look idle meanwhile
    const state = play([spawn('orchestrator', undefined, true), spawn('toolu_fork', 'orchestrator', false, true), spawn('toolu_sub', 'toolu_fork')])
    expect(state.agents.get('toolu_fork')?.state).toBe('thinking')
    expect(state.agents.get('toolu_sub')?.state).toBe('thinking')
  })

  it('waits for a prompt when it is the main agent', () => {
    const state = play([spawn('orchestrator', undefined, true)])
    expect(state.agents.get('orchestrator')?.state).toBe('idle')
  })
})
