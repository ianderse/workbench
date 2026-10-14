/**
 * Holographic color palette, in a dark and a light variant that follow the
 * app's theme (see setGraphTheme). The background itself is the page's
 * (bg-background), so the canvas only draws on top of it.
 */

import type { AgentState, ToolCallNode } from './agent-types'

// Holographic Color Palette (dark theme)
const DARK = {
  // Primary Hologram
  holoBase: '#0088FF',
  holoHot: '#ffffff',

  // Agent States
  idle: '#FF4081',
  thinking: '#0088FF',
  tool_calling: '#FCA935',
  complete: '#3FB950',
  error: '#ff5566',
  waiting_permission: '#A855F7',

  // Tool nodes: a finished call, a running one
  return: '#3FB950',
  tool: '#FCA935',

  // UI Chrome
  nodeInterior: 'rgba(10, 15, 40, 0.5)',

  // Canvas drawing — tool node backgrounds (partial rgba, alpha appended at draw time)
  toolNodeErrorBase: 'rgba(40, 10, 15,',
  toolNodeBase: 'rgba(10, 15, 30,',

  // Canvas drawing — near-invisible fill that casts an agent's drop shadow
  agentShadowFill: 'rgba(0, 0, 0, 0.01)',
  agentShadow: 'rgba(0, 0, 0, 0.5)',
}

type Palette = { [K in keyof typeof DARK]: string }

// Light theme: deeper state colors that keep their contrast on a light
// background, light node interiors, and flashes in the base color (white
// doesn't show there)
const LIGHT: Palette = {
  holoBase: '#0969DA',
  holoHot: '#0550AE',

  idle: '#C2255C',
  thinking: '#0969DA',
  tool_calling: '#B86E00',
  complete: '#1A7F37',
  error: '#CF222E',
  waiting_permission: '#8250DF',

  return: '#1A7F37',
  tool: '#B86E00',

  nodeInterior: 'rgba(255, 255, 255, 0.85)',

  toolNodeErrorBase: 'rgba(255, 235, 238,',
  toolNodeBase: 'rgba(255, 255, 255,',

  agentShadowFill: 'rgba(0, 0, 0, 0.01)',
  agentShadow: 'rgba(0, 0, 0, 0.15)',
}

/** The colors of the current theme */
export const COLORS: Palette = { ...DARK }

let darkTheme = true

/** Switch the palette to the app's light or dark theme */
export function setGraphTheme(dark: boolean): void {
  darkTheme = dark
  Object.assign(COLORS, dark ? DARK : LIGHT)
}

/** Whether the dark palette is in use (the glow (bloom) only adds up on a dark background) */
export function isGraphThemeDark(): boolean {
  return darkTheme
}

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

/** Safely combine a partial rgba base (e.g. 'rgba(10, 15, 30,') with an alpha value */
export function withAlpha(rgbaBase: string, alpha: number): string {
  return `${rgbaBase} ${alpha})`
}
