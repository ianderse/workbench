import type { CompletablePhase, ExecutionPhase } from '../../shared/constants/phase-protocol';
import type { ClaudeRunInfo } from '../../shared/types/claude-code';
import type { Project, Task } from '../../shared/types';
import type { TaskRunOutcome, TaskRunSubtask } from '../claude-code/task-runner';
import type { TaskEventPayload } from './task-event-schema';

/**
 * Agent-specific types for running tasks through Claude Code
 */

export interface ExecutionProgressData {
  phase: ExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
  currentSubtask?: string;
  message?: string;
  completedPhases?: CompletablePhase[];
}

/** Kind of run that exited (kept as a type for listeners that log it) */
export type ProcessType = 'task-execution';

/** How a task run is started */
export interface StartTaskOptions {
  project: Project;
  task: Task;
  /** start: new or continued run; revise: apply reviewer feedback in the same session */
  mode: 'start' | 'revise';
  feedback?: string;
  /** Absolute paths of images attached to the feedback */
  feedbackImagePaths?: string[];
  /** Claude profile to run on (undefined = best available) */
  profileId?: string;
}

/** Details of an authentication failure, forwarded to the renderer */
export interface AgentAuthFailure {
  profileId?: string;
  failureType?: 'missing' | 'invalid' | 'expired' | 'unknown';
  message?: string;
  originalError?: string;
}

export interface AgentManagerEvents {
  log: (taskId: string, log: string, projectId?: string) => void;
  error: (taskId: string, error: string, projectId?: string) => void;
  /** Run ended (not emitted when the run was stopped by killTask/restartTask). code 0 = completed */
  exit: (taskId: string, code: number | null, processType: ProcessType, projectId?: string) => void;
  /** Full outcome of a run, emitted right before `exit` */
  'run-finished': (taskId: string, outcome: TaskRunOutcome, projectId?: string) => void;
  'execution-progress': (taskId: string, progress: ExecutionProgressData, projectId?: string) => void;
  'task-event': (taskId: string, event: TaskEventPayload, projectId?: string) => void;
  /** Claude Code run state changed (claude_run.json) */
  'run-info': (taskId: string, info: ClaudeRunInfo, projectId?: string) => void;
  /** Claude Code's task list changed (mirrored as the task's subtasks) */
  subtasks: (taskId: string, subtasks: TaskRunSubtask[], projectId?: string) => void;
  'auth-failure': (taskId: string, failure: AgentAuthFailure) => void;
}
