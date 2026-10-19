/**
 * IPC Handlers Module Index
 *
 * This module exports a single setup function that registers all IPC handlers
 * organized by domain into separate handler modules.
 */

import type { BrowserWindow } from 'electron';
import { AgentManager } from '../agent';
import { TerminalManager } from '../terminal-manager';

// Import all handler registration functions
import { registerProjectHandlers } from './project-handlers';
import { registerTaskHandlers } from './task-handlers';
import { registerTerminalHandlers } from './terminal-handlers';
import { registerAgenteventsHandlers } from './agent-events-handlers';
import { registerSettingsHandlers } from './settings-handlers';
import { registerInsightsHandlers } from './insights-handlers';
import { registerAppUpdateHandlers } from './app-update-handlers';
import { registerClaudeCodeHandlers } from './claude-code-handlers';
import { registerGraphifyHandlers } from './graphify-handlers';
import { registerSelfImproveHandlers } from './self-improve-handlers';
import { registerLiveAgentHandlers } from './live-agent-handlers';
import { registerMcpHandlers } from './mcp-handlers';
import { registerProfileHandlers } from './profile-handlers';
import { registerTerminalWorktreeIpcHandlers } from './terminal';
import { notificationService } from '../notification-service';
import { setAgentManagerRef } from './utils';

/**
 * Setup all IPC handlers across all domains
 *
 * @param agentManager - The agent manager instance
 * @param terminalManager - The terminal manager instance
 * @param getMainWindow - Function to get the main BrowserWindow
 */
export function setupIpcHandlers(
  agentManager: AgentManager,
  terminalManager: TerminalManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // Initialize notification service
  notificationService.initialize(getMainWindow);

  // Wire up agent manager for circuit breaker cleanup
  setAgentManagerRef(agentManager);

  // Project handlers
  registerProjectHandlers(getMainWindow);

  // Task handlers
  registerTaskHandlers(agentManager, getMainWindow);

  // Terminal and Claude profile handlers
  registerTerminalHandlers(terminalManager, getMainWindow, agentManager);

  // Terminal worktree handlers (isolated development in worktrees)
  registerTerminalWorktreeIpcHandlers();

  // Agent event handlers (event forwarding from agent manager to renderer)
  registerAgenteventsHandlers(agentManager, getMainWindow);

  // Settings and dialog handlers
  registerSettingsHandlers(agentManager, getMainWindow);

  // Insights handlers
  registerInsightsHandlers(getMainWindow);

  // App auto-update handlers
  registerAppUpdateHandlers();

  // Claude Code CLI handlers (version checking, installation)
  registerClaudeCodeHandlers();

  // Graphify CLI handlers (version, installation, project memory graph)
  registerGraphifyHandlers();
  registerSelfImproveHandlers();

  // Live agent handlers (relay status, agent windows' graph subscriptions)
  registerLiveAgentHandlers();

  // MCP server health check handlers
  registerMcpHandlers();

  // API Profile handlers (custom Anthropic-compatible endpoints)
  registerProfileHandlers();

  console.warn('[IPC] All handler modules registered successfully');
}

// Re-export all individual registration functions for potential custom usage
;
