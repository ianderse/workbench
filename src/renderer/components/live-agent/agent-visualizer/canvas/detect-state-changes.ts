import type { Agent, ToolCallNode } from '../../lib/agent-types'
import { FX } from '../../lib/agent-types'
import { COLORS, getToolColor } from '../../lib/colors'
import { displayedState } from '../../hooks/graph/types'
import type { VisualEffect } from './draw-effects'

/**
 * Compare previous and current agent/tool states and return the visual effects
 * to spawn (agent spawn/complete, tool completion) plus the updated state maps.
 * Agents are compared in the state they're shown in (`awaiting`, see
 * displayedState), so one waiting on its sub-agents bursts when it turns green.
 */
export function detectStateChanges(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  awaiting: Set<string>,
  prevAgentStates: Map<string, string>,
  prevToolStates: Map<string, string>,
): {
  effects: VisualEffect[]
  newAgentStates: Map<string, string>
  newToolStates: Map<string, string>
} {
  const effects: VisualEffect[] = []
  const newAgentStates = new Map<string, string>()
  const newToolStates = new Map<string, string>()

  for (const [id, agent] of agents) {
    const state = displayedState(agent, awaiting)
    newAgentStates.set(id, state)
    const oldState = prevAgentStates.get(id)

    // Spawn: new agent (wasn't in prev)
    if (!oldState && agent.opacity < 0.5) {
      effects.push({
        type: 'spawn', x: agent.x, y: agent.y,
        color: COLORS.holoBase, age: 0, duration: FX.spawnDuration,
      })
    }

    // Complete: just became complete
    if (oldState && oldState !== 'complete' && state === 'complete') {
      effects.push({
        type: 'complete', x: agent.x, y: agent.y,
        color: COLORS.complete, age: 0, duration: FX.completeDuration,
      })
    }
  }

  for (const [id, tool] of toolCalls) {
    newToolStates.set(id, tool.state)
    const oldState = prevToolStates.get(id)

    // Tool just completed
    if (oldState === 'running' && tool.state === 'complete') {
      const particleData: VisualEffect['particles'] = []
      for (let i = 0; i < FX.shatterCount; i++) {
        particleData.push({
          angle: (i / FX.shatterCount) * Math.PI * 2 + Math.random() * 0.5,
          speed: FX.shatterSpeed.min + Math.random() * FX.shatterSpeed.range,
          size: FX.shatterSize.min + Math.random() * FX.shatterSize.range,
        })
      }
      effects.push({
        type: 'shatter', x: tool.x, y: tool.y,
        color: getToolColor('complete'), age: 0, duration: FX.shatterDuration,
        particles: particleData,
      })
    }
  }

  return { effects, newAgentStates, newToolStates }
}
