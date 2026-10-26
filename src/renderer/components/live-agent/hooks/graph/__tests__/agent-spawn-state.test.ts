import { describe, it, expect } from 'vitest'
import type { GraphEvent } from '../../../lib/agent-types'
import { createEmptyState, type GraphState } from '../types'
import { processEvent } from '../process-event'
import { computeNextFrame, SUBAGENT_START_QUIET_S } from '../animate'

const spawn = (name: string, parent?: string, isMain = false, satellite = false): GraphEvent => ({
  time: 0,
  type: 'agent_spawn',
  payload: { name, isMain, ...(parent ? { parent } : {}), ...(satellite ? { satellite } : {}) },
})

function play(events: GraphEvent[]): GraphState {
  return events.reduce((state, event) => processEvent(event, state), createEmptyState())
}

const message = (agent: string, time = 0): GraphEvent => ({ time, type: 'message', payload: { agent } })

/** One frame at graph time `time` */
const frameAt = (state: GraphState, time: number): GraphState =>
  computeNextFrame(time - state.currentTime, time, state, { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })

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

  it('falls back to idle when it does nothing for a while, like a dead one found again on re-attach', () => {
    const state = play([spawn('orchestrator', undefined, true), spawn('toolu_dead', 'orchestrator')])
    expect(frameAt(state, SUBAGENT_START_QUIET_S - 1).agents.get('toolu_dead')?.state).toBe('thinking')
    expect(frameAt(state, SUBAGENT_START_QUIET_S).agents.get('toolu_dead')?.state).toBe('idle')
  })

  it('keeps working past the quiet period once it has done something', () => {
    const state = play([spawn('orchestrator', undefined, true), spawn('toolu_sub', 'orchestrator'), message('toolu_sub', 5)])
    expect(frameAt(state, SUBAGENT_START_QUIET_S * 2).agents.get('toolu_sub')?.state).toBe('thinking')
  })
})
