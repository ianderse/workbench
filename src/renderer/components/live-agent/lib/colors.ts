/**
 * Holographic color palette, the same in the light and dark themes. The
 * background is the agent window's (bg-sidebar, as behind the terminal), so
 * the canvas only draws on top of it.
 */

import type { AgentState, ToolCallNode } from './agent-types'

// Holographic Color Palette
export const COLORS = {
  // Primary Hologram
  holoBase: '#C6613F',
  holoHot: '#A855F7',

  // Agent States
  idle: '#FF4081',
  thinking: '#0088FF',
  tool_calling: '#FCA935',
  complete: '#00C950',
  error: '#FB2C36',
  waiting_permission: '#A855F7',

  // Tool nodes: a finished call, a running one
  return: '#00C950',
  tool: '#FCA935',
} as const

// ─── Color Helper Functions ──────────────────────────────────────────────────

/** A tool node's color: running, failed, or finished */
export function getToolColor(state: ToolCallNode['state']): string {
  return state === 'running' ? COLORS.tool : state === 'error' ? COLORS.error : COLORS.return
}

export function getStateColor(state: AgentState): string {
  switch (state) {
    case 'idle': return COLORS.idle
    case 'thinking': return COLORS.thinking
    case 'tool_calling': return COLORS.tool_calling
    case 'complete': return COLORS.complete
    case 'error': return COLORS.error
    case 'waiting_permission': return COLORS.waiting_permission
  }
}
