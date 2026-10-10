/**
 * Agent module: runs tasks through the Claude Code CLI
 *
 * - AgentManager: starts, stops and restarts task runs (ClaudeTaskRun) and emits their events
 * - AgentState: running tasks and their Claude profile assignments
 */

export { AgentManager } from './agent-manager';
export { AgentState } from './agent-state';

export type {
  AgentAuthFailure,
  AgentManagerEvents,
  ExecutionProgressData,
  ProcessType,
  StartTaskOptions,
} from './types';
