/**
 * Agent module: runs tasks through the Claude Code CLI
 *
 * - AgentManager: starts, stops and restarts task runs (ClaudeTaskRun) and emits their events
 * - AgentState: running tasks and their Claude profile assignments
 */

export { AgentManager } from './agent-manager';
;

export type {
  AgentAuthFailure,
  
  ExecutionProgressData,
  ProcessType,
  
} from './types';
