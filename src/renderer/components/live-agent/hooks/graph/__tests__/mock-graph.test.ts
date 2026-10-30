import { describe, it, expect } from 'vitest'
import { buildMockGraph } from '../mock-graph'

describe('buildMockGraph', () => {
  const graph = buildMockGraph()
  const agents = [...graph.agents.values()]
  const tools = [...graph.toolCalls.values()]

  it('has a sub-agent in every state under the master node, and a subtask', () => {
    const main = agents.find((agent) => agent.isMain)!
    const states = agents.filter((agent) => agent.parentId === main.id && !agent.isSatellite).map((agent) => agent.state)
    expect(new Set(states)).toEqual(new Set(['idle', 'thinking', 'tool_calling', 'complete', 'error', 'waiting_permission']))
    expect(agents.some((agent) => agent.isSatellite && agent.parentId === main.id)).toBe(true)
  })

  it('has tool calls running, finished and failed', () => {
    expect(new Set(tools.map((tool) => tool.state))).toEqual(new Set(['running', 'complete', 'error']))
  })

  it('is fully shown and still', () => {
    expect([...agents, ...tools].every((node) => node.opacity === 1)).toBe(true)
    expect(graph.isPlaying).toBe(false)
  })
})
