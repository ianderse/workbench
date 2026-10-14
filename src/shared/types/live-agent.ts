/**
 * Live agent: agent windows show a live agent-flow graph of their Claude Code session
 * (Settings > Claude Code > Live agent)
 */

/** The relay that feeds the graphs (a worker in the main process) */
export interface LiveAgentStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  /** Why it could not start or stopped (with 'error') */
  error?: string;
}
