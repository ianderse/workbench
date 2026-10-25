/**
 * Claude Code task execution types
 *
 * Every task is delegated to the Claude Code CLI (`claude -p`) running in the task's git
 * worktree. A short triage run picks the model, effort and whether to plan first; then
 * Claude Code plans (optional), implements and validates in one resumable session.
 */

import type { SpecReviewReport } from './spec-review';

/** Model aliases accepted by `claude --model` */
export type ClaudeModelAlias = 'haiku' | 'sonnet' | 'opus' | 'fable';

/** Effort levels accepted by `claude --effort` */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** How a task's model and effort are chosen */
export type TriageMode = 'auto' | 'fixed';

/** Whether a task is planned (Claude Code plan mode) before it is implemented */
export type PlanningPolicy = 'auto' | 'always' | 'never';

/** App-wide defaults for running tasks with Claude Code (Settings > Claude Code) */
export interface ClaudeCodeTaskSettings {
  /** auto: a triage run assesses each task; fixed: always use fixedModel/fixedEffort */
  triage: TriageMode;
  /** Model used when triage is fixed, or when triage fails */
  fixedModel: ClaudeModelAlias;
  /** Effort used when triage is fixed, or when triage fails */
  fixedEffort: ClaudeEffort;
  /** Model used for the triage run itself */
  triageModel: ClaudeModelAlias;
  /** auto: follow triage; always / never: override it */
  planning: PlanningPolicy;
  /** Run checks and a fresh-context review of the diff after implementing */
  validation: boolean;
  /**
   * How many AI review rounds a task gets (1 to 5, default 3): after a review that finds open
   * blocker or major findings, the task is sent back to fix them and reviewed again, up to this
   * many reviews in total. 1 = a single pass. Ignored while `validation` is off.
   */
  aiReviewRounds: number;
  /** Let triage pick Fable for the hardest tasks (Fable may bill to usage credits) */
  allowFable: boolean;
  /** Fallback model chain when the chosen model is overloaded (`--fallback-model`) */
  fallbackModel?: string;
  /**
   * Parallel tasks message each other (Workbench's `message_task` and `list_parallel_tasks`
   * tools) and get Workbench's notices about each other (started, overlapping files, finished,
   * merged)
   */
  taskMessaging: boolean;
}

export const DEFAULT_CLAUDE_CODE_TASK_SETTINGS: ClaudeCodeTaskSettings = {
  triage: 'auto',
  fixedModel: 'sonnet',
  fixedEffort: 'medium',
  triageModel: 'sonnet',
  planning: 'auto',
  validation: true,
  aiReviewRounds: 3,
  allowFable: false,
  taskMessaging: true,
};

/** Size of a task as judged by triage */
export type TaskScope = 'trivial' | 'small' | 'medium' | 'large';

/** Triage decision for a task */
export interface TaskTriage {
  /** Tier alias, or the exact model id when the user pinned one on the task */
  model: string;
  effort: ClaudeEffort;
  needsPlan: boolean;
  scope: TaskScope;
  /** Short task title (sentence case, no trailing period) */
  title: string;
  /** One or two sentences on why this model, effort and plan decision fit */
  reasoning: string;
  /** Commands or checks that can verify the change (tests, typecheck, build, ...) */
  verification: string[];
  /** auto: decided by the triage run; fixed: from settings; fallback: triage failed */
  source: 'auto' | 'fixed' | 'fallback';
  /** The user pinned the model and/or effort on the task (they replace what triage chose) */
  pinned?: { model?: boolean; effort?: boolean };
  /** The ticket involves frontend / UI work: it gets a design spec from the design model (missing = false) */
  uiWork?: boolean;
}

/**
 * Steps of a task run. `resync`: the task's base branch moved on (another task was merged into it)
 * and the task's session merges it in, then resumes its work (`task-resync/`)
 */
export type ClaudeRunPhaseName = 'triage' | 'plan' | 'implement' | 'validate' | 'revise' | 'review' | 'spec_review' | 'resync';

export interface ClaudeRunPhase {
  name: ClaudeRunPhaseName;
  model?: string;
  effort?: ClaudeEffort;
  permissionMode?: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  isError?: boolean;
  error?: string;
  /** resync: what was merged in, and whether the step also carried on with unfinished work */
  resync?: { ref: string; into: string; continued: boolean };
}

/** What Claude Code loaded for the session (from the stream's `system/init` event) */
interface ClaudeRunInit {
  claudeCodeVersion?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  tools: string[];
  agents: string[];
  skills: string[];
  slashCommands: string[];
  mcpServers: { name: string; status: string }[];
  plugins: string[];
}

/** A subagent or background task Claude Code started during the run */
interface ClaudeRunSubagent {
  id: string;
  description: string;
  type?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  endedAt?: string;
}

interface ValidationCheck {
  name: string;
  command?: string;
  passed: boolean;
  details?: string;
}

export interface ValidationFinding {
  severity: 'critical' | 'major' | 'minor';
  description: string;
  fixed: boolean;
  file?: string;
  line?: number;
}

export const MIN_AI_REVIEW_ROUNDS = 1;
export const MAX_AI_REVIEW_ROUNDS = 5;

/** A finding that was still open after a review round (severity normalised: critical = blocker) */
export interface ReviewRoundFinding {
  severity: 'blocker' | 'major' | 'minor';
  description: string;
  file?: string;
  line?: number;
}

/** One AI review round of the review loop */
export interface ReviewRound {
  /** 1 = the first review */
  round: number;
  status: ValidationReport['status'];
  summary: string;
  /** Blocker and major findings still open after this round's review */
  openFindings: ReviewRoundFinding[];
  /** Names of the checks that failed in this round */
  failingChecks: string[];
  /** Blocker and major findings resolved since the round before (round 1: fixed during the review) */
  fixedCount: number;
  /** Open findings that were not open in the round before */
  newCount: number;
  startedAt: string;
  endedAt: string;
}

/** Why a task still fails AI review after its last round, for the person who takes over */
export interface ReviewFailureSummary {
  /** One to three sentences from the last report */
  reason: string;
  openFindings: ReviewRoundFinding[];
  failingChecks: string[];
  /** One line per round ("Round 2: fixed 3, 1 still open") */
  roundLines: string[];
}

/** The final verdict of the AI review loop */
export interface ReviewVerdict {
  status: 'passed' | 'failed';
  /** Rounds that ran */
  rounds: number;
  /** Rounds allowed (the setting when the run started) */
  maxRounds: number;
  /** Present when status is failed */
  failure?: ReviewFailureSummary;
}

/** Structured result of the validation step */
export interface ValidationReport {
  status: 'passed' | 'failed' | 'partial';
  summary: string;
  checks: ValidationCheck[];
  findings: ValidationFinding[];
}

/** Where Claude Code ran: natively on the host OS, or inside WSL (Windows, wsl shell) */
export type ClaudeRuntime = 'native' | 'wsl';

/** Plain-language account of what a ticket delivered, written by Workbench for the person reviewing it */
export interface ReviewSummary {
  /** One sentence: what the ticket now delivers */
  headline: string;
  /** 3 to 5 short bullets about capabilities and behaviour */
  whatChanged: string[];
  /** One short sentence on how the work was checked */
  verified: string;
  /** 0 to 4 things the reviewer should know or decide */
  needsAttention: string[];
  /** When it was written (ISO) */
  generatedAt: string;
}

/** Persisted run state of a task (`<specDir>/claude_run.json`) */
export interface ClaudeRunInfo {
  version: 1;
  /** Claude Code session that holds the task's conversation (resumable) */
  sessionId?: string;
  /**
   * Claude profile the session ran on. Its transcript lives in that profile's config dir, so
   * resuming the session (e.g. from an agent window) must use the same profile.
   */
  profileId?: string;
  /** Claude config dir of that profile (where the session transcript is stored), as a host path */
  configDir?: string;
  /**
   * Where the session ran (unset = native). A session can't be resumed in the other runtime (its
   * transcript lives in that runtime's config dir, under that runtime's project path), so a
   * change of runtime starts a new session.
   */
  runtime?: ClaudeRuntime;
  /** Agent backend that made `sessionId` (unset = Claude Code); a backend change starts a new session */
  backend?: 'claude' | 'omp';
  triage?: TaskTriage;
  /** Approved plan (Markdown), when the task was planned */
  plan?: string;
  /** A split proposed after planning is waiting for Apply or Dismiss; `plan` covers only the kept scope */
  pendingSplit?: { proposalId: string; plan: string };
  phases: ClaudeRunPhase[];
  init?: ClaudeRunInit;
  validation?: ValidationReport;
  /** Result of a Spec review ticket */
  specReview?: SpecReviewReport;
  /** Every AI review round of the latest review loop */
  reviewRounds?: ReviewRound[];
  /** Final verdict of the latest review loop */
  reviewVerdict?: ReviewVerdict;
  /** Final summary Claude wrote for the user */
  summary?: string;
  /** Reviewer summary Workbench wrote after the run (absent until generated, or when generation failed) */
  reviewSummary?: ReviewSummary;
  subagents: ClaudeRunSubagent[];
  totalCostUsd: number;
  /** Absolute path of the worktree the session runs in */
  worktreePath?: string;
  updatedAt: string;
}

