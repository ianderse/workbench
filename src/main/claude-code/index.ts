/**
 * Claude Code integration
 * =======================
 *
 * Auto Claude delegates all AI work to the locally installed Claude Code CLI:
 * - task-runner: runs a task (triage, plan, implement, validate) in its worktree
 * - run-text: one-shot headless calls for app utilities (titles, PR text, merge help)
 * - inventory: what Claude Code loads for a project (agents, skills, hooks, MCP, CLAUDE.md)
 */

export { resolveClaudeEnv } from './env';
export type { ClaudeEnvResult, ClaudeEnvOptions } from './env';
export { startClaudeProcess } from './process';
export type { ClaudeProcessHandle, ClaudeProcessOptions, ClaudeProcessResult } from './process';
export { runClaudeText, ClaudeCodeRunError, READ_ONLY_TOOLS } from './run-text';
export type { RunClaudeTextOptions, RunClaudeTextResult } from './run-text';
export { triageTask, fixedTriage, applyPlanningPolicy } from './triage';
export { buildMcpConfig } from './mcp-config';
export { TaskLogWriter } from './task-log';
export {
  ClaudeTaskRun,
  CLAUDE_RUN_FILE,
  loadClaudeRunInfo,
  resetClaudeRunInfo,
  isClaudeRunFinished,
} from './task-runner';
export type {
  TaskAttachment,
  TaskRunCallbacks,
  TaskRunConfig,
  TaskRunOutcome,
  TaskRunProgress,
  TaskRunStatus,
  TaskRunSubtask,
} from './task-runner';
export { detectClaudeLimitMessage, parseLimitResetTime, isValidTimeZone } from './limit';
export { resolveClaudeCodeTaskSettings } from './settings';
