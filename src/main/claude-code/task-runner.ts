/**
 * Claude Code task runner
 * =======================
 *
 * Runs one Workbench task through the Claude Code CLI, in the task's git worktree:
 *
 *   triage    short read-only run: model, effort, plan or not (see triage.ts)
 *   plan      optional: `--permission-mode plan`, returns the plan as structured output
 *   implement resumes the same session with `--dangerously-skip-permissions` (the worktree
 *             isolates the run) and the triage model/effort
 *   validate  optional: same session runs the project's checks, reviews the diff with fresh
 *             eyes (/code-review or a subagent), commits, and returns a structured report
 *   revise    after "request changes": same session gets the reviewer's feedback, then validates
 *
 * Planning, implementation and validation share one Claude Code session, so the context built
 * while exploring carries into the work (Claude Code's "explore, plan, code" workflow). Claude
 * decides on its own when subagents, skills, MCP tools or the task list help.
 *
 * State lives in `<specDir>/claude_run.json` (ClaudeRunInfo) so a stopped, rate-limited or
 * crashed run continues where it left off.
 */

import { randomUUID } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveClaudeEnv } from './env';
import { startClaudeProcess, type ClaudeProcessHandle } from './process';
import { buildMcpConfig } from './mcp-config';
import { triageTask, fixedTriage, applyPlanningPolicy, applyAgentOverrideToTriage } from './triage';
import { TaskLogWriter, summarizeToolInput } from './task-log';
import { buildParallelTasksPrompt } from '../task-changelog';
import { git } from '../utils/git-exec';
import { stageTaskWork } from './stage-excludes';
import { getWslInfo, toHostPath, toRuntimePath, whenShellRuntimeReady } from '../platform/shell-runtime';
import { buildAttachmentBlocks } from '../insights/message-content';
import { detectClaudeLimitMessage, parseLimitResetTime } from './limit';
import {
  isApiRetry,
  isAssistantMessage,
  isInitMessage,
  isRateLimitEvent,
  isResultMessage,
  isTaskNotification,
  isTaskStarted,
  isUserMessage,
  type ClaudeResultMessage,
  type ClaudeStreamMessage,
  type ClaudeToolResultBlock,
  type ClaudeUserContentBlock,
} from './stream-types';
import type {
  ClaudeCodeTaskSettings,
  ClaudeEffort,
  ClaudeModelAlias,
  ClaudeRunInfo,
  ClaudeRuntime,
  ClaudeRunPhase,
  ClaudeRunPhaseName,
  TaskTriage,
  ValidationReport,
} from '../../shared/types/claude-code';
import type { McpConnectorSettings } from '../../shared/types/settings';
import type { ExecutionPhase } from '../../shared/constants/phase-protocol';
import type { ImageAttachment, SubtaskStatus, TaskLogPhase } from '../../shared/types/task';
import { DATA_DIR_NAMES } from '../../shared/constants';
import { PHASE_PROMPT_OPENINGS } from './phase-prompts';
import { appLog } from '../app-logger';
import { getAgentBackendSettings } from '../agent-backend/settings';
import type { AgentBackendKind } from '../../shared/types/agent-backend';
import type { AgentOverride } from '../../shared/types/task';
import { OMP_READ_ONLY_TOOLS, ompMaxRetries, ompRoleForJob, resolveOmpSelection, modelAliasOf, type OmpRole } from '../agent-backend/omp-args';
import { getOmpRoles } from '../agent-backend/omp-roles';
import { buildOmpMemoryPrompt } from '../self-improve/nudge';
import { startOmpProcess } from '../agent-backend/omp-process';
import { isOmpNotice, isOmpProgress, isOmpTodos } from '../agent-backend/omp-translate';
import { StreamProgress } from '../agent-backend/stream-progress';
import { classifyOmpFailure, ompRetryDelayMs } from '../agent-backend/omp-retry';
import { runClaudeText, READ_ONLY_TOOLS } from './run-text';
import {
  collectReviewDiff,
  countFindings,
  formatReviewForValidation,
  normalizeReview,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
} from './review-diff';

export const CLAUDE_RUN_FILE = 'claude_run.json';
/** Workbench's size names for the tier aliases (Settings > Agents) */
const OMP_SIZE_NAMES: Record<ClaudeModelAlias, string> = { haiku: 'Small', sonnet: 'Standard', opus: 'Large', fable: 'Largest' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Other attachments (PDFs, text files; text is also truncated when inlined) */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Tools whose file edits go to the task hooks (and so the project's task changelog) */
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// =============================================================================
// Public types
// =============================================================================

export interface TaskAttachment {
  /** Absolute path of the image file */
  path: string;
  filename: string;
  mimeType: string;
}

export interface TaskRunConfig {
  taskId: string;
  projectId?: string;
  specId: string;
  /** Main project spec dir: run state, logs and plan are written here */
  specDir: string;
  /** Worktree the Claude Code session works in */
  worktreePath: string;
  /**
   * The session works in its own git worktree (default). When false it works directly in the
   * project checkout, so permission checks stay on (auto mode) instead of being bypassed.
   */
  isolated?: boolean;
  branch: string;
  baseBranch: string;
  title: string;
  description: string;
  attachments: TaskAttachment[];
  /** Connector ids for the task (undefined = Connectors defaults) */
  connectorIds?: string[];
  connectorSettings?: McpConnectorSettings;
  settings: ClaudeCodeTaskSettings;
  /** The project's budget per task (`--max-budget-usd`, Settings > Project); unset = no cap */
  maxBudgetUsd?: number;
  /** Prompt section pointing Claude Code at the project's Graphify memory graph */
  graphifyPrompt?: string;
  /** Tells the session to save what it learns, when the project's self-improve switch is on */
  selfImprovePrompt?: string;
  /** The project's memory directory (self-improve); OMP is told where it is, since it has no auto memory */
  selfImproveDir?: string;
  /** The project's task changelog; each phase's prompt lists what the other tasks are changing */
  changelogPath?: string;
  /** Extra environment (e.g. GRAPHIFY_OUT, PATH with the graphify CLI) */
  extraEnv?: Record<string, string>;
  /** start: new or continued run; revise: apply reviewer feedback */
  mode: 'start' | 'revise';
  feedback?: string;
  feedbackAttachments?: TaskAttachment[];
  /** Claude profile to use (undefined = best available) */
  profileId?: string;
  /** Backend for the whole task (its override, else the app-wide backend); decided once per start */
  backend: AgentBackendKind;
  /** Model/effort the user pinned on the task; they replace triage's choice */
  agentOverride?: AgentOverride;
}

interface TaskRunProgress {
  phase: ExecutionPhase;
  phaseProgress: number;
  overallProgress: number;
  message: string;
  currentSubtask?: string;
}

export interface TaskRunSubtask {
  id: string;
  title: string;
  description: string;
  status: SubtaskStatus;
}

export interface TaskRunCallbacks {
  /** Plain log line for the live terminal-style log */
  onLog?: (line: string) => void;
  onProgress?: (progress: TaskRunProgress) => void;
  /** Task state machine event (CODING_STARTED, QA_PASSED, RATE_LIMIT_HOLD, ...) */
  onTaskEvent?: (type: string, payload: Record<string, unknown>) => void;
  onRunInfo?: (info: ClaudeRunInfo) => void;
  /** Claude Code's task list (TaskCreate/TaskUpdate), mirrored as the task's subtasks */
  onSubtasks?: (subtasks: TaskRunSubtask[]) => void;
  /** Files the session edits (relative to the worktree, forward slashes), for the task hooks */
  onFilesEdited?: (files: string[]) => void;
}

type TaskRunStatus = 'completed' | 'failed' | 'rate_limited' | 'auth_failed' | 'stopped';

export interface TaskRunOutcome {
  status: TaskRunStatus;
  error?: string;
  rateLimit?: { message: string; resetAt?: string };
  validation?: ValidationReport;
}

// =============================================================================
// Prompts
// =============================================================================

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'The implementation plan in Markdown' },
  },
  required: ['plan'],
};

const VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'partial'] },
    summary: { type: 'string', description: 'Short summary for the reviewer: what changed, how it was verified, assumptions and follow-ups' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          passed: { type: 'boolean' },
          details: { type: 'string' },
        },
        required: ['name', 'passed'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          description: { type: 'string' },
          fixed: { type: 'boolean' },
        },
        required: ['severity', 'description', 'fixed'],
      },
    },
  },
  required: ['status', 'summary', 'checks', 'findings'],
};

function buildSystemPrompt(config: TaskRunConfig, specDirRelative: string, parallelTasksPrompt?: string, omp = false): string {
  const sections = [
    `You are running autonomously inside Workbench, a desktop app that hands coding tasks to ${omp ? 'a coding agent' : 'Claude Code'}. Nobody watches this session live and nobody can answer questions: make reasonable assumptions, state them in your final summary, and keep going.`,
    config.isolated === false
      ? `## Environment
- Your working directory is the user's project checkout on branch \`${config.branch}\` (this task runs without a separate worktree). Keep changes focused on the task.
- Never push, force-push, rewrite history, publish packages or deploy.
- Workbench keeps its own task files in \`${specDirRelative}\`. Don't modify or commit them.`
      : `## Environment
- Your working directory is an isolated git worktree on branch \`${config.branch}\`, created from \`${config.baseBranch}\`. Edits here never touch the user's main checkout. Stay inside this worktree.
- Permission checks are off because of that isolation. Still never push, force-push, rewrite the history of \`${config.baseBranch}\`, publish packages, deploy, or change anything outside the worktree.
- Workbench keeps its own task files in \`${specDirRelative}\`. Don't modify or commit them.`,
    `## How to work
- Follow the project's CLAUDE.md, conventions and existing patterns. Keep the change focused on the task.
${omp
  ? `- Track work with the todo tool only when it has several distinct steps worth tracking; skip it for small changes.
- Do the work yourself in this conversation.
`
  : `- Track work with the task list (TaskCreate / TaskUpdate) only when it has several distinct steps worth tracking; skip it for small changes.
- Use subagents only when they help: broad searches whose raw output you don't need, or independent investigations that can run in parallel. Do the implementation itself in this conversation.
- Use skills and MCP tools when they fit the task.
`}- Verify your work with the project's own checks (tests, type checker, linter, build) for the code you changed, and fix failures you caused. Show evidence rather than asserting success.
- Keep generated folders (node_modules, build output, virtual environments) out of commits: if the project has no .gitignore for them, create or extend one before installing dependencies or committing.
- When the work is done, commit it in this worktree with a descriptive message. Don't push.
- End with a short summary for the reviewer: what changed, how you verified it, and any assumptions or follow-ups.`,
  ];
  if (config.graphifyPrompt) sections.push(config.graphifyPrompt);
  if (config.selfImprovePrompt) sections.push(config.selfImprovePrompt);
  if (parallelTasksPrompt) sections.push(parallelTasksPrompt);
  return sections.join('\n\n');
}

function taskBlock(config: TaskRunConfig): string {
  return `<task title="${config.title.replace(/"/g, "'")}">\n${config.description}\n</task>`;
}

/**
 * What a discarded attempt got wrong, for a run started over from "Request changes" with
 * "Start over" ticked. Empty for a normal start and for a revision (which quotes the feedback
 * as the change to apply).
 *
 * The reviewer can say it in screenshots alone, so notes with no text still introduce the images
 * that are attached to the same turn - without a sentence naming them, they arrive looking like
 * part of the task rather than a verdict on the attempt being discarded.
 *
 * `images` is how many images the turn really carries, which is the caller's to count: an
 * attachment that is too large or cannot be read is dropped from the turn, and a sentence
 * introducing images that are not there would leave the model looking for them.
 */
function restartNotes(config: TaskRunConfig, images: number): string {
  if (config.mode !== 'start') return '';
  const feedback = config.feedback?.trim();
  if (!feedback && images === 0) return '';
  const opening = `\n\nAn earlier attempt at this task was discarded and you are starting it over. The reviewer's notes on that attempt:`;
  if (!feedback) {
    return `${opening}\n\n${images === 1 ? 'the attached image' : `the ${images} attached images`}.`;
  }
  return `${opening}

<feedback>
${feedback}
</feedback>`;
}

/**
 * What the reviewer asked for, as the `revise` turn states it. Empty when they asked for it in no
 * way at all, which only the caller can phrase sensibly.
 *
 * The reviewer can say it in screenshots alone, so a request with no text points at the images
 * attached to the same turn instead of quoting an empty `<feedback>` block. The handler used to
 * substitute "No feedback provided" for the missing text, which told the model there was nothing
 * to go on while the request itself sat in the attachments it had just been handed.
 *
 * `images` is how many images the turn really carries, which is the caller's to count. A request
 * whose only screenshot was too large to attach has to read as the empty request it has become -
 * pointing at an image that was dropped would send the model after something it was never given,
 * and would also keep it from the "no notes came with the request" wording that is the one honest
 * instruction left.
 */
function reviewerFeedback(config: TaskRunConfig, images: number): string {
  const feedback = config.feedback?.trim();
  if (feedback) {
    return `

<feedback>
${feedback}
</feedback>`;
  }
  if (images === 0) return '';
  return `\n\n${images === 1 ? 'see the attached image' : `see the ${images} attached images`}.`;
}

function verificationHint(triage: TaskTriage | undefined): string {
  if (triage?.verification.length) {
    return `the checks that apply to the code you changed (for example: ${triage.verification.map((v) => `\`${v}\``).join(', ')})`;
  }
  return `the checks that apply to the code you changed (the project's tests, type checker, linter or build)`;
}

// =============================================================================
// Runner
// =============================================================================

/** Steps that run in the task's session */
type SessionPhaseName = Exclude<ClaudeRunPhaseName, 'triage' | 'review'>;

interface PhaseResult {
  result?: ClaudeResultMessage;
  rateLimit?: { message: string; resetAt?: string };
  authFailed?: boolean;
  stopped: boolean;
  error?: string;
}

export class ClaudeTaskRun {
  private readonly runFile: string;
  private info: ClaudeRunInfo;
  private readonly log: TaskLogWriter;
  private current: ClaudeProcessHandle | null = null;
  private readonly abortController = new AbortController();
  private stopped = false;
  private subtasks: TaskRunSubtask[] = [];
  /** TaskCreate tool_use id -> subtask under construction */
  private pendingTaskCreates = new Map<string, TaskRunSubtask>();
  /** Main-thread tool_use id -> tool name, for matching results */
  private toolNames = new Map<string, string>();
  /** Agent tool_use id -> description, for labeling subagent activity in the log */
  private subagentLabels = new Map<string, string>();
  private rejectedRateLimitResetAt: string | undefined;
  /** The current phase reports its own cost (OMP), not the running total of the session (Claude Code) */
  private costIsPerRun = false;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Fresh-context review (OMP) for the validate prompt; set by `runOmpReview` */
  private reviewSection: string | undefined;

  constructor(private readonly config: TaskRunConfig, private readonly callbacks: TaskRunCallbacks = {}) {
    this.runFile = path.join(config.specDir, CLAUDE_RUN_FILE);
    this.info = loadClaudeRunInfo(config.specDir) ?? {
      version: 1,
      phases: [],
      subagents: [],
      totalCostUsd: 0,
      updatedAt: new Date().toISOString(),
    };
    this.info.worktreePath = config.worktreePath;
    this.log = new TaskLogWriter(config.specDir, config.specId);
  }

  /** Stop the run; the outcome resolves with status 'stopped' */
  /** Current session, profile and config dir of the run (they change on a profile swap) */
  get session(): { sessionId?: string; profileId?: string; configDir?: string } {
    return { sessionId: this.info.sessionId, profileId: this.info.profileId, configDir: this.info.configDir };
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
    this.current?.stop();
  }

  /** Run (or continue) the task to the end */
  async run(): Promise<TaskRunOutcome> {
    try {
      return await this.runSteps();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.stopped) return { status: 'stopped' };
      this.emitLog(`Run failed: ${message}`);
      this.callbacks.onTaskEvent?.('CODING_FAILED', { subtaskId: '', error: message, attemptCount: 1 });
      return { status: 'failed', error: message };
    } finally {
      this.flushInfo();
      this.log.saveNow();
    }
  }

  private async runSteps(): Promise<TaskRunOutcome> {
    const settings = this.config.settings;

    if (this.config.mode === 'revise') {
      // Each change request runs the same workflow: assess it (model and effort for the
      // change), apply it in the task's session, then validate
      const triaged = await this.runTriage(true);
      if (triaged) return triaged;
      const revised = await this.runSessionPhase('revise');
      if (revised) return revised;
      if (settings.validation) {
        const validated = await this.runSessionPhase('validate');
        if (validated) return validated;
      }
      return this.finish();
    }

    // 1. Triage
    if (!this.info.triage) {
      const triaged = await this.runTriage();
      if (triaged) return triaged;
    }
    // A run that continues after the user changed the pin on the task takes the new pin
    const ov = this.config.agentOverride;
    const known = this.info.triage!;
    if ((ov?.model && known.model !== ov.model) || (ov?.effort && known.effort !== ov.effort)) {
      this.info.triage = applyAgentOverrideToTriage({ ...known, pinned: undefined }, ov);
      this.saveInfo();
    }
    const triage = this.info.triage!;

    // 2. Plan (only before implementation started)
    const implementStarted = this.info.phases.some((p) => p.name === 'implement');
    if (triage.needsPlan && !this.info.plan && !implementStarted) {
      const planned = await this.runSessionPhase('plan');
      if (planned) return planned;
    }

    // 3. Implement
    if (!this.hasCompleted('implement')) {
      const implemented = await this.runSessionPhase('implement');
      if (implemented) return implemented;
    }

    // 4. Validate
    if (settings.validation && !this.hasCompleted('validate')) {
      const validated = await this.runSessionPhase('validate');
      if (validated) return validated;
    }

    return this.finish();
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /**
   * Model and effort for a step's log line. Under OMP the tier alias and effort mean nothing on
   * their own ("opus" is the Large size, effort becomes a thinking level), so name what runs.
   */
  private modelLabel(model: string, effort: ClaudeEffort, role: OmpRole = 'default'): string {
    if (this.config.backend !== 'omp') return `${model}, ${effort}`;
    const { omp } = getAgentBackendSettings();
    const selection = resolveOmpSelection(model, omp, role, getOmpRoles());
    const thinking = `thinking ${omp.thinking[effort]}`;
    if (selection.source === 'role') {
      return `OMP ${selection.role} role${selection.concrete ? `: ${selection.concrete}` : ''}, ${thinking}`;
    }
    if (selection.source === 'none') return `OMP default model, ${thinking}`;
    const alias = modelAliasOf(model);
    const size = selection.source === 'size' && alias ? `${OMP_SIZE_NAMES[alias]} size: ` : '';
    return `${size}${selection.selector}, ${thinking}`;
  }

  /** Name of the task's backend, for log lines */
  private backendName(): string {
    return this.config.backend === 'omp' ? 'OMP' : 'Claude Code';
  }

  private async runTriage(revision = false): Promise<TaskRunOutcome | null> {
    const { settings } = this.config;
    const label = revision ? 'Assessing the requested changes' : 'Assessing the task';
    this.emitProgress('planning', 0.05, label);
    this.log.startPhase('planning', label);
    const phase = this.beginPhase('triage', { model: settings.triageModel, effort: 'low' });

    let triage: TaskTriage;
    let triageCost: number | undefined;
    if (settings.triage === 'fixed') {
      triage = fixedTriage(settings, this.config.title, 'fixed', 'Fixed model and effort from Settings > Agents');
    } else {
      // Triage is a text-only run: it is handed the attachments' filenames, never their bytes, so
      // what it can refer to is every image the reviewer attached and not the smaller set the
      // phases themselves manage to carry
      const named = this.config.feedbackAttachments?.length ?? 0;
      try {
        ({ triage, costUsd: triageCost } = await triageTask({
          description: revision
            // Triage sizes the follow-up from the same statement of it the revise turn gets, with
            // the image filenames it already lists standing in for feedback the reviewer drew
            ? `${this.config.description}\n\nThis task was already implemented. Assess only the follow-up change the reviewer requested:${reviewerFeedback(this.config, named) || '\n\nthey left no notes with the request.'}`
            : `${this.config.description}${restartNotes(this.config, named)}`,
          cwd: this.config.worktreePath,
          attachmentNames: (revision ? this.config.feedbackAttachments ?? [] : this.config.attachments).map((a) => a.filename),
          settings,
          abortSignal: this.abortController.signal,
          profileId: this.config.profileId,
          backend: this.config.backend,
          override: this.config.agentOverride,
        }));
      } catch (error) {
        if (this.stopped) return { status: 'stopped' };
        const message = error instanceof Error ? error.message : String(error);
        const limit = detectClaudeLimitMessage(message);
        if (limit) return this.rateLimited('triage', phase, { message: limit.message, resetAt: this.resetAt(limit.resetText) });
        this.emitLog(`Triage failed, using the default model: ${message}`);
        triage = fixedTriage(settings, this.config.title, 'fallback', `Triage failed (${message}); used the default model and effort`);
      }
    }
    triage = applyPlanningPolicy(applyAgentOverrideToTriage(triage, this.config.agentOverride), settings);
    if (revision) {
      // A change request is applied directly in the session (no separate plan) and keeps the title
      triage = { ...triage, needsPlan: false, title: this.info.triage?.title || this.config.title };
    }
    this.info.triage = triage;
    this.endPhase(phase, triageCost !== undefined ? { costUsd: triageCost } : {});
    this.updateTotalCost();
    this.log.add('planning', 'info',
      `${triage.pinned ? 'Model pinned: ' : 'Model '}${triage.model}, effort ${triage.effort}, ${triage.needsPlan ? 'plan first' : 'no plan'} (${triage.scope})`,
      { detail: triage.reasoning || undefined });
    this.emitLog(`${triage.pinned ? 'Triage (model pinned)' : 'Triage'}: ${triage.model} / ${triage.effort} / ${triage.needsPlan ? 'plan first' : 'no plan'}. ${triage.reasoning}`);
    this.saveInfo();
    return null;
  }

  /** Run a Claude Code session step; returns an outcome when the run must stop */
  private async runSessionPhase(name: SessionPhaseName): Promise<TaskRunOutcome | null> {
    const triage = this.info.triage ?? fixedTriage(this.config.settings, this.config.title, 'fallback', 'No triage recorded');
    const model = name === 'plan' && !triage.pinned?.model ? (triage.model === 'fable' ? 'fable' : 'opus') : triage.model;
    const effort: ClaudeEffort = name === 'plan' && !triage.pinned?.effort && (triage.effort === 'low' || triage.effort === 'medium') ? 'high' : triage.effort;
    const logPhase: TaskLogPhase = name === 'plan' ? 'planning' : name === 'validate' ? 'validation' : 'coding';
    const role = ompRoleForJob(name);

    // A session lives in the runtime it ran in (native or WSL); after a switch, start a new one
    await whenShellRuntimeReady();
    const runtime = currentRuntime();
    if (this.info.sessionId && (this.info.runtime ?? 'native') !== runtime) {
      this.emitLog(`${this.backendName()} now runs ${runtime === 'wsl' ? 'in WSL' : 'natively'}, so this step starts a new session`);
      this.info.sessionId = undefined;
    }
    if (this.info.runtime !== runtime) {
      this.info.runtime = runtime;
      this.saveInfo();
    }
    // A session belongs to the backend that made it (Claude Code transcript or OMP session file)
    const backend = this.config.backend;
    if (this.info.sessionId && (this.info.backend ?? 'claude') !== backend) {
      this.emitLog(`The agent backend is now ${backend === 'omp' ? 'OMP' : 'Claude Code'}, so this step starts a new session`);
      this.info.sessionId = undefined;
    }
    if ((this.info.backend ?? 'claude') !== backend) {
      this.info.backend = backend;
      this.saveInfo();
    }

    const resumeSessionId = this.info.sessionId;
    const continuing = name === 'implement' && this.info.phases.some((p) => p.name === 'implement');
    const label = {
      plan: 'Planning',
      implement: continuing ? 'Continuing implementation' : 'Implementing',
      validate: 'Validating',
      revise: 'Applying requested changes',
    }[name];

    if (name === 'plan') {
      this.emitProgress('planning', 0.15, label);
      this.log.startPhase('planning', `${label} (${this.modelLabel(model, effort, role)})`);
    } else if (name === 'implement' || name === 'revise') {
      this.callbacks.onTaskEvent?.('CODING_STARTED', { subtaskId: '', subtaskDescription: label });
      this.emitProgress('coding', 0.2, label);
      this.log.startPhase('coding', `${label} (${this.modelLabel(model, effort, role)})`);
    } else {
      this.callbacks.onTaskEvent?.('QA_STARTED', { iteration: 1, maxIterations: 1 });
      this.emitProgress('qa_review', 0.85, label);
      this.log.startPhase('validation', `${label} (${this.modelLabel(model, effort, role)})`);
    }

    // OMP: Workbench runs the fresh-context review itself, before the session validates
    this.reviewSection = undefined;
    if (name === 'validate' && backend === 'omp') {
      await this.runOmpReview();
      if (this.stopped) {
        this.log.endPhase(logPhase, 'stopped', 'Stopped');
        return { status: 'stopped' };
      }
    }

    const sessionId = resumeSessionId ?? randomUUID();
    const phase = this.beginPhase(name, {
      model,
      effort,
      permissionMode: name === 'plan' ? 'plan' : this.config.isolated === false ? 'auto' : 'bypassPermissions',
      // OMP picks the session id itself: it is stored when the run reports it
      sessionId: backend === 'omp' ? resumeSessionId : sessionId,
    });
    if (!this.info.sessionId && backend !== 'omp') this.info.sessionId = sessionId;
    this.saveInfo();

    const outcome = await this.runClaude({
      name,
      model,
      effort,
      sessionId,
      resume: !!resumeSessionId,
      input: this.buildInput(name, continuing, !!resumeSessionId),
      jsonSchema: name === 'plan' ? PLAN_SCHEMA : name === 'validate' ? VALIDATION_SCHEMA : undefined,
      logPhase,
    });

    if (outcome.stopped) {
      this.endPhase(phase, { isError: true, error: 'Stopped' });
      this.log.endPhase(logPhase, 'stopped', 'Stopped');
      return { status: 'stopped' };
    }
    if (outcome.rateLimit) return this.rateLimited(name, phase, outcome.rateLimit);
    if (outcome.authFailed) {
      const error = 'Claude Code is not signed in or the sign-in expired. Re-authenticate the account in Settings > Accounts.';
      this.endPhase(phase, { isError: true, error });
      this.log.endPhase(logPhase, false, error);
      this.failEvent(name, error);
      return { status: 'auth_failed', error };
    }

    const result = outcome.result;
    if (!result || result.is_error || result.subtype !== 'success') {
      const error = outcome.error
        || result?.errors?.join('; ')
        || (result?.subtype === 'error_max_budget_usd' ? 'The task reached its budget limit (Settings > Project)' : '')
        || result?.result
        || `${this.backendName()} stopped with an error`;
      this.endPhase(phase, { isError: true, error }, result);
      this.log.endPhase(logPhase, false, error);
      this.failEvent(name, error);
      return { status: 'failed', error };
    }

    this.endPhase(phase, {}, result);
    if (name === 'plan') {
      const structured = result.structured_output as { plan?: unknown } | undefined;
      const plan = typeof structured?.plan === 'string' && structured.plan.trim() ? structured.plan : (result.result ?? '');
      this.info.plan = plan;
      writeFileSafe(path.join(this.config.specDir, 'plan.md'), plan);
      this.log.add('planning', 'success', 'Plan ready', { detail: plan, collapsed: true });
      this.log.endPhase('planning', true, 'Plan ready');
    } else if (name === 'validate') {
      const report = normalizeValidation(result.structured_output, result.result);
      this.info.validation = report;
      this.info.summary = report.summary || this.info.summary;
      this.log.add('validation', report.status === 'failed' ? 'error' : 'success', `Validation ${report.status}`, {
        detail: report.summary,
      });
      this.log.endPhase('validation', report.status !== 'failed', `Validation ${report.status}`);
    } else {
      this.info.summary = result.result?.trim() || this.info.summary;
      this.log.endPhase('coding', true, name === 'revise' ? 'Changes applied' : 'Implementation finished');
      if (name === 'revise') this.info.validation = undefined;
    }
    this.saveInfo();
    return null;
  }

  private async finish(): Promise<TaskRunOutcome> {
    await this.commitLeftovers();
    const validation = this.info.validation;
    this.emitProgress('complete', 1, 'Ready for review');
    if (validation?.status === 'failed') {
      this.callbacks.onTaskEvent?.('QA_FAILED', {
        iteration: 1,
        issueCount: validation.findings.filter((f) => !f.fixed).length || 1,
        issues: validation.findings.filter((f) => !f.fixed).map((f) => f.description),
      });
    } else {
      this.callbacks.onTaskEvent?.('QA_PASSED', { iteration: 1, testsRun: {} });
    }
    return { status: 'completed', validation };
  }

  // ---------------------------------------------------------------------------
  // Claude Code process
  // ---------------------------------------------------------------------------

  private buildInput(name: SessionPhaseName, continuing: boolean, resume: boolean): ClaudeUserContentBlock[] {
    const triage = this.info.triage;

    // The attachments are turned into blocks before the prompt is written, because the prompt has
    // to describe the images that will really be in the turn. Reading them is what decides that:
    // an image over `MAX_IMAGE_BYTES`, or one that cannot be read at all, is dropped here, and a
    // reviewer who said everything in one oversized screenshot would otherwise be quoted as
    // "see the attached image" in a turn carrying no image whatsoever.
    //
    // The task's attachments go with the session's first turn; feedback images with the revision.
    // Like the Claude chat: images as images, PDFs as documents, text files inlined
    const taskBlocks = buildAttachmentBlocks(this.readAttachments(resume ? [] : this.config.attachments));
    const feedbackBlocks = buildAttachmentBlocks(
      this.readAttachments(name === 'revise' || !resume ? this.config.feedbackAttachments ?? [] : [])
    );
    const feedbackImages = feedbackBlocks.filter((block) => block.type === 'image').length;

    const blocks: ClaudeUserContentBlock[] = [];
    let text: string;

    switch (name) {
      case 'plan':
        text = `${taskBlock(this.config)}${restartNotes(this.config, feedbackImages)}

Explore the codebase as needed and produce an implementation plan for this task. Don't change any files yet.
The plan should name the files to change, the approach and why, edge cases, and how to verify the result (${verificationHint(triage)}).`;
        break;
      case 'implement':
        if (continuing && resume) {
          text = `${PHASE_PROMPT_OPENINGS.continuing} Check \`git status\` and \`git log\` to see what is already done, then finish the work.`;
        } else if (this.info.plan && resume) {
          text = `${PHASE_PROMPT_OPENINGS.planApproved}, verify it with ${verificationHint(triage)}, and commit the result.`;
        } else if (continuing || this.info.plan) {
          // A new session for work that started in another one (the runtime changed): the task,
          // the approved plan and what was done so far go with the first message
          const plan = this.info.plan ? `\n\nThe approved implementation plan:\n\n<plan>\n${this.info.plan}\n</plan>` : '';
          const started = continuing
            ? '\n\nAn earlier session already worked on this task in this worktree. Check `git status` and `git log` to see what is already done.'
            : '';
          text = `${taskBlock(this.config)}${restartNotes(this.config, feedbackImages)}${plan}${started}

Implement this task${plan ? ' as planned' : ''}. Verify it with ${verificationHint(triage)}, then commit the result.`;
        } else {
          text = `${taskBlock(this.config)}${restartNotes(this.config, feedbackImages)}

Implement this task. Verify it with ${verificationHint(triage)}, then commit the result.`;
        }
        break;
      case 'validate':
        text = `${resume ? '' : `${taskBlock(this.config)}\n\n`}${PHASE_PROMPT_OPENINGS.validate}
1. Run ${verificationHint(triage)}. Fix failures your change caused.
2. ${this.reviewSection && this.config.backend === 'omp'
  ? this.reviewSection
  : `Review the full change against \`${this.config.baseBranch}\` (\`git diff ${this.config.baseBranch}...HEAD\` plus any uncommitted changes) with fresh eyes. ${this.config.backend === 'omp' ? 'Read the diff carefully as a reviewer who sees only the diff and the task.' : "Use the /code-review skill if it's available; otherwise use a subagent that sees only the diff and the task."} Fix only findings that affect correctness or the task's requirements; don't gold-plate.`}
3. Commit any remaining changes.
Then return the report: status "passed" when the change works and the checks pass, "partial" when some checks couldn't run, "failed" when something is still broken.`;
        break;
      case 'revise': {
        const opening = `${resume ? '' : `${taskBlock(this.config)}\n\n`}${PHASE_PROMPT_OPENINGS.revise}`;
        const requested = reviewerFeedback(this.config, feedbackImages);
        // Nothing to apply when the reviewer sent the request back empty: saying so and asking for
        // another look is the only honest instruction left, where "apply them" would point at air
        text = requested
          ? `${opening}${requested}

Apply them, verify with ${verificationHint(triage)}, and commit the result.`
          : `${opening}

no notes came with the request, so review the change against the task with fresh eyes and fix whatever does not meet it. Verify with ${verificationHint(triage)}, and commit the result.`;
        break;
      }
    }
    blocks.push({ type: 'text', text });
    blocks.push(...taskBlocks, ...feedbackBlocks);
    return blocks;
  }

  /**
   * The attachments as the turn can carry them: read from disk, with the ones the request cannot
   * hold left out. An image over `MAX_IMAGE_BYTES` (or any other file over `MAX_ATTACHMENT_BYTES`)
   * and one that cannot be read are both reported to the task's log and dropped, so what comes
   * back is exactly what the prompt may refer to.
   */
  private readAttachments(attachments: TaskAttachment[]): ImageAttachment[] {
    const files: ImageAttachment[] = [];
    for (const attachment of attachments) {
      try {
        const data = readFileSync(attachment.path);
        const limit = attachment.mimeType.startsWith('image/') ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
        if (data.byteLength > limit) {
          this.emitLog(`${attachment.filename} is too large to attach`);
          continue;
        }
        files.push({
          id: attachment.filename,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: data.byteLength,
          data: data.toString('base64'),
        });
      } catch {
        this.emitLog(`Could not attach ${attachment.filename}`);
      }
    }
    return files;
  }

  private async runClaude(params: {
    name: SessionPhaseName;
    model: string;
    effort: ClaudeEffort;
    sessionId: string;
    resume: boolean;
    input: ClaudeUserContentBlock[];
    jsonSchema?: Record<string, unknown>;
    logPhase: TaskLogPhase;
  }): Promise<PhaseResult> {
    if (this.stopped) return { stopped: true };
    if (this.config.backend === 'omp') return this.runOmp(params);
    this.costIsPerRun = false;
    const { settings } = this.config;
    // Stay on the profile that holds the session transcript, unless the caller switched profiles
    // (rate-limit swap); then the transcript is copied to the new profile below
    const { command, env, profileId } = await resolveClaudeEnv({
      profileId: this.config.profileId ?? (params.resume ? this.info.profileId : undefined),
      extraEnv: {
        ...(this.config.extraEnv ?? {}),
        // Make the task list available on every model, so Claude can track multi-step work
        // and the app can show it as the task's subtasks
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      },
    });

    // Host path of the config dir (the transcript is copied with Windows file APIs, also in WSL)
    const configDir = env.CLAUDE_CONFIG_DIR ? toHostPath(env.CLAUDE_CONFIG_DIR) : defaultClaudeConfigDir();
    if (params.resume && this.info.configDir && this.info.configDir !== configDir) {
      copySessionTranscript(params.sessionId, this.info.configDir, configDir);
    }
    if (this.info.profileId !== profileId || this.info.configDir !== configDir) {
      this.info.profileId = profileId;
      this.info.configDir = configDir;
      this.saveInfo();
    }
    const specDirRelative = (getWslInfo() ? path.posix : path).join('.workbench', DATA_DIR_NAMES.tasks, this.config.specId);
    // Read at every phase, so a resumed session learns what the other tasks changed meanwhile
    const parallelTasksPrompt = this.config.changelogPath
      ? await buildParallelTasksPrompt(this.config.changelogPath, this.config.specId, path.dirname(this.config.specDir), toRuntimePath(this.config.changelogPath))
      : undefined;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', params.model,
      '--effort', params.effort,
      '--permission-prompts', 'none',
      '--append-system-prompt', buildSystemPrompt(this.config, specDirRelative, parallelTasksPrompt),
      '--name', `${this.config.specId}: ${this.info.triage?.title || this.config.title}`.slice(0, 120),
    ];
    if (params.name === 'plan') {
      args.push('--permission-mode', 'plan');
    } else if (this.config.isolated === false) {
      // Not isolated: a classifier reviews actions instead of skipping all checks
      args.push('--permission-mode', 'auto');
    } else {
      args.push('--dangerously-skip-permissions');
    }
    if (params.resume) {
      args.push('--resume', params.sessionId);
    } else {
      args.push('--session-id', params.sessionId);
    }
    if (params.jsonSchema) args.push('--json-schema', JSON.stringify(params.jsonSchema));
    if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    if (settings.fallbackModel?.trim()) args.push('--fallback-model', settings.fallbackModel.trim());
    const mcpConfig = buildMcpConfig(this.config.connectorIds, this.config.connectorSettings);
    if (Object.keys(mcpConfig.mcpServers).length > 0) args.push('--mcp-config', JSON.stringify(mcpConfig));

    this.rejectedRateLimitResetAt = undefined;
    let rateLimit: PhaseResult['rateLimit'];
    let authFailed = false;

    this.current = startClaudeProcess({
      command,
      args,
      cwd: this.config.worktreePath,
      env,
      input: params.input,
      abortSignal: this.abortController.signal,
      onMessage: (message) => {
        const signal = this.handleMessage(message, params.logPhase);
        if (signal === 'rate_limit' && !rateLimit) rateLimit = { message: 'Claude usage limit reached' };
        if (signal === 'auth') authFailed = true;
      },
      onStderr: (chunk) => {
        const line = chunk.trim();
        if (line) this.emitLog(line);
      },
    });
    const outcome = await this.current.done;
    this.current = null;

    if (this.stopped || outcome.aborted) return { stopped: true };

    const result = outcome.result;
    if (result) {
      const limit = detectClaudeLimitMessage(result.result) ?? detectClaudeLimitMessage(result.errors?.join(' '));
      if (limit) {
        rateLimit = { message: limit.message, resetAt: this.resetAt(limit.resetText) };
      } else if (result.is_error && result.api_error_status === 429) {
        rateLimit = rateLimit ?? { message: result.result || 'Rate limited' };
      } else if (result.is_error && (result.api_error_status === 401 || result.api_error_status === 403)) {
        authFailed = true;
      }
    }
    if (rateLimit && !rateLimit.resetAt) rateLimit.resetAt = this.rejectedRateLimitResetAt;
    if (rateLimit) return { rateLimit, stopped: false, result };
    if (authFailed) return { authFailed, stopped: false, result };
    if (!result) {
      const error = outcome.stderr.trim().split('\n').slice(-3).join(' ') || `${this.backendName()} exited with code ${outcome.exitCode}`;
      return { stopped: false, error };
    }
    return { result, stopped: false };
  }

  /**
   * One phase through OMP (oh-my-pi) instead of Claude Code. The JSON event stream is translated
   * into Claude's stream messages, so `handleMessage` and everything behind it is shared.
   * Not supported: connectors (MCP), a budget cap, a fallback model, subagent/skill commands.
   */
  private async runOmp(params: {
    name: SessionPhaseName;
    model: string;
    effort: ClaudeEffort;
    sessionId: string;
    resume: boolean;
    input: ClaudeUserContentBlock[];
    jsonSchema?: Record<string, unknown>;
    logPhase: TaskLogPhase;
  }): Promise<PhaseResult> {
    const { omp } = getAgentBackendSettings();
    this.costIsPerRun = true;
    const specDirRelative = (getWslInfo() ? path.posix : path).join('.workbench', DATA_DIR_NAMES.tasks, this.config.specId);
    const parallelTasksPrompt = this.config.changelogPath
      ? await buildParallelTasksPrompt(this.config.changelogPath, this.config.specId, path.dirname(this.config.specDir), toRuntimePath(this.config.changelogPath))
      : undefined;
    const planning = params.name === 'plan';
    let systemPrompt = buildSystemPrompt(this.config, specDirRelative, parallelTasksPrompt, true);
    if (this.config.selfImprovePrompt && this.config.selfImproveDir) {
      // The memory index is read at every phase, so notes saved by an earlier phase are included
      let memoryIndex = '';
      try {
        memoryIndex = readFileSync(path.join(this.config.selfImproveDir, 'MEMORY.md'), 'utf-8').slice(0, 25_000);
      } catch {
        // No memories yet
      }
      systemPrompt = `${systemPrompt}\n\n${buildOmpMemoryPrompt(this.config.selfImproveDir, memoryIndex)}`;
    }
    if (Object.keys(buildMcpConfig(this.config.connectorIds, this.config.connectorSettings).mcpServers).length > 0) {
      appLog.info('[OMP] Connectors (MCP servers) are not available with the OMP backend and are ignored');
    }
    if (this.config.isolated === false) {
      appLog.info('[OMP] This task runs in the project checkout; OMP has no auto mode, so tool calls are approved without review');
    }

    this.rejectedRateLimitResetAt = undefined;
    // A retry continues the same phase: what failed attempts spent is added to the final result
    const carried = { cost: 0, turns: 0, durationMs: 0 };
    const withCarried = (result: ClaudeResultMessage): ClaudeResultMessage => ({
      ...result,
      total_cost_usd: (result.total_cost_usd ?? 0) + carried.cost,
      num_turns: (result.num_turns ?? 0) + carried.turns,
      duration_ms: (result.duration_ms ?? 0) + carried.durationMs,
    });
    let resume: string | undefined = params.resume ? params.sessionId : undefined;
    let input = params.input;
    let retries = 0;
    const maxRetries = ompMaxRetries(omp);
    // The one final attempt (after the retries on the local model) that lets OMP use its fallback models
    let fallbackAttempt = false;

    for (;;) {
      const progress = new StreamProgress();
      const handle = await startOmpProcess({
        settings: omp,
        cwd: this.config.worktreePath,
        env: this.config.extraEnv,
        prompt: input,
        model: params.model,
        role: ompRoleForJob(params.name),
        allowFallback: fallbackAttempt,
        effort: params.effort,
        // Planning is read-only (OMP has no plan permission mode): fewer tools and a note in the prompt
        tools: planning ? OMP_READ_ONLY_TOOLS : 'all',
        autoApprove: !planning,
        appendSystemPrompt: planning
          ? `${systemPrompt}\n\nYou are in planning mode: do not modify files, run only read-only commands, and finish with the implementation plan.`
          : systemPrompt,
        session: { dir: path.join(this.config.specDir, 'omp-sessions'), resume },
        jsonSchema: params.jsonSchema,
        maxTimeMinutes: omp.maxPhaseMinutes,
        emitProgress: true,
        abortSignal: this.abortController.signal,
        onMessage: (message) => {
          if (isOmpProgress(message)) {
            // A long reply shows nothing else: a throttled line keeps the log (and the card's activity) alive
            const line = progress.add(message.chars, Date.now());
            if (line) {
              this.log.add(params.logPhase, 'info', line);
              this.emitLog(line);
            }
            return;
          }
          if (isAssistantMessage(message) || isUserMessage(message)) progress.reset();
          this.handleMessage(message, params.logPhase);
        },
        onStderr: (chunk) => {
          const line = chunk.trim();
          if (line) this.emitLog(line);
        },
      });
      this.current = handle;
      if (this.stopped) handle.stop();
      const outcome = await handle.done;
      this.current = null;

      if (this.stopped || outcome.aborted) return { stopped: true };
      const result = outcome.result;
      const failed = !result || result.is_error || result.subtype !== 'success';
      const stderrTail = outcome.stderr.trim().split('\n').slice(-3).join(' ');
      if (!failed) return { result: withCarried(result), stopped: false };

      const kind = classifyOmpFailure({
        errors: result?.omp_errors,
        fallbackText: [result?.errors?.join('; '), result?.result, stderrTail].filter(Boolean).join(' '),
        signal: outcome.signal,
        timedOut: outcome.timedOut,
      });
      const exhausted = kind === 'transient' && retries >= maxRetries;
      const useFallback = exhausted && omp.allowFallbackModels === true && !fallbackAttempt;
      const delay = kind === 'transient' && !exhausted ? ompRetryDelayMs(retries + 1) : undefined;
      if (delay === undefined && !useFallback) {
        if (kind === 'transient') this.noteLog(params.logPhase, `Giving up after ${retries} ${retries === 1 ? 'retry' : 'retries'} of this step`);
        if (result) return { result: withCarried(result), stopped: false };
        return { stopped: false, error: stderrTail || `OMP exited with code ${outcome.exitCode}` };
      }

      // Transient provider or network error: continue the same step in the same session after a pause.
      // Retries and the fallback attempt continue one phase, so their cost and turns are added up
      if (result) {
        carried.cost += result.total_cost_usd ?? 0;
        carried.turns += result.num_turns ?? 0;
        carried.durationMs += result.duration_ms ?? 0;
      }
      const reason = (result?.omp_errors?.find((e) => !e.fallback)?.text || result?.errors?.join('; ') || stderrTail || 'unknown error').slice(0, 300);
      if (useFallback) {
        fallbackAttempt = true;
        this.noteLog(params.logPhase, `Temporary error (${reason}). Retries on the local model failed; trying once more with OMP fallback models allowed`);
      } else {
        retries++;
        this.noteLog(params.logPhase, `Temporary error (${reason}). Retry ${retries}/${maxRetries} in ${formatDelay(delay!)}`);
        if (!(await this.sleep(delay!))) return { stopped: true };
      }
      const sessionId = this.info.sessionId;
      if (sessionId) {
        resume = sessionId;
        input = [{
          type: 'text',
          text: 'The previous attempt was interrupted by a temporary provider or network error. Continue where you left off: check `git status` and `git log` for what is already done, do not redo finished work, and finish the step.',
        }];
      } else {
        // The session never started: begin the step again from the original prompt
        resume = undefined;
        input = params.input;
      }
    }
  }

  /** A line for the task log and the live log */
  private noteLog(logPhase: TaskLogPhase, line: string): void {
    this.log.add(logPhase, 'info', line);
    this.emitLog(line);
  }

  /** Wait `ms`; false when the run was stopped meanwhile */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve(false);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.abortController.signal.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(!this.stopped), ms);
      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * OMP: a separate one-shot run reviews the diff with fresh context (no session, read-only tools,
   * the Large model); its findings go into the validate prompt. A failed review is logged and the
   * validation goes on without it.
   */
  private async runOmpReview(): Promise<void> {
    const cwd = this.config.worktreePath;
    let diff: string | undefined;
    try {
      diff = await collectReviewDiff(cwd, this.config.baseBranch);
    } catch (error) {
      this.noteLog('validation', `Review skipped, could not read the diff: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!diff) {
      this.noteLog('validation', 'Review skipped: no changes to review');
      return;
    }
    const reviewTriage = this.info.triage;
    const reviewModel = reviewTriage?.pinned?.model ? reviewTriage.model : 'opus';
    const reviewEffort: ClaudeEffort = reviewTriage?.pinned?.effort ? reviewTriage.effort : 'high';
    this.noteLog('validation', `Reviewing the change with a fresh context (${this.modelLabel(reviewModel, reviewEffort, ompRoleForJob('review'))})`);
    const phase = this.beginPhase('review', { model: reviewModel, effort: reviewEffort });
    const started = Date.now();
    try {
      const result = await runClaudeText({
        prompt: `${taskBlock(this.config)}\n\nThis is the change made for the task:\n\n<diff>\n${diff}\n</diff>`,
        appendSystemPrompt: REVIEW_SYSTEM_PROMPT,
        model: reviewModel,
        ompRole: ompRoleForJob('review'),
        effort: reviewEffort,
        backend: this.config.backend,
        jsonSchema: REVIEW_SCHEMA,
        cwd,
        tools: READ_ONLY_TOOLS,
        // Local models are slow; one-shot OMP runs get five times this
        timeoutMs: 20 * 60 * 1000,
        abortSignal: this.abortController.signal,
      });
      const report = normalizeReview(result.structured, result.text);
      const counts = countFindings(report.findings);
      Object.assign(phase, { endedAt: new Date().toISOString(), costUsd: result.costUsd ?? 0, durationMs: Date.now() - started });
      this.updateTotalCost();
      this.saveInfo();
      this.reviewSection = formatReviewForValidation(report);
      const detail = [report.summary, ...report.findings.map((f) => `${f.severity}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.issue}`)].filter(Boolean).join('\n');
      this.log.add('validation', 'info', `Review: ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor`, { detail, collapsed: true });
      this.emitLog(`Review: ${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor. ${report.summary}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Object.assign(phase, { endedAt: new Date().toISOString(), isError: true, error: message, durationMs: Date.now() - started });
      this.saveInfo();
      if (!this.stopped) this.noteLog('validation', `Review failed, validating without it: ${message}`);
    }
  }

  /** Apply one stream message; returns a signal for rate-limit or auth problems */
  private handleMessage(message: ClaudeStreamMessage, logPhase: TaskLogPhase): 'rate_limit' | 'auth' | undefined {
    if (isInitMessage(message)) {
      this.info.init = {
        claudeCodeVersion: message.claude_code_version,
        model: message.model,
        permissionMode: message.permissionMode,
        cwd: message.cwd ? toHostPath(message.cwd) : message.cwd,
        tools: message.tools ?? [],
        agents: message.agents ?? [],
        skills: message.skills ?? [],
        slashCommands: message.slash_commands ?? [],
        mcpServers: message.mcp_servers ?? [],
        plugins: (message.plugins ?? []).map((p) => p.name),
      };
      if (message.session_id) this.info.sessionId = message.session_id;
      this.saveInfo();
      return undefined;
    }

    if (isAssistantMessage(message)) {
      if (message.error === 'rate_limit') return 'rate_limit';
      if (message.error === 'authentication_failed' || message.error === 'oauth_org_not_allowed') return 'auth';
      const inSubagent = message.parent_tool_use_id !== null;
      const subphase = inSubagent ? this.subagentLabels.get(message.parent_tool_use_id!) ?? 'Subagent' : undefined;
      for (const block of message.message.content) {
        if (block.type === 'text' && 'text' in block && block.text.trim()) {
          if (!inSubagent) {
            this.log.add(logPhase, 'text', block.text.trim());
            this.emitLog(block.text.trim());
          }
        } else if (block.type === 'tool_use' && 'name' in block) {
          this.onToolUse(block.id, block.name, block.input ?? {}, logPhase, inSubagent, subphase);
        }
      }
      return undefined;
    }

    if (isUserMessage(message) && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') this.onToolResult(block as ClaudeToolResultBlock, logPhase, message.parent_tool_use_id !== null);
      }
      return undefined;
    }

    if (isOmpTodos(message)) {
      this.subtasks = message.todos.map((todo, index) => ({
        id: String(index + 1),
        title: todo.content,
        description: '',
        status: todo.status,
      }));
      this.emitSubtasks();
      return undefined;
    }

    if (isOmpNotice(message)) {
      // Advisor notes and OMP notices go to the task log only: they are not part of the answer
      const label = message.source === 'advisor' ? 'Advisor' : 'OMP notice';
      const severity = message.severity ? ` (${message.severity})` : '';
      const advisor = message.advisor ? ` [${message.advisor}]` : '';
      const line = `${label}${advisor}${severity}: ${message.text}`;
      this.log.add(logPhase, 'info', line);
      this.emitLog(line);
      return undefined;
    }

    if (isTaskStarted(message) && !message.ambient && message.task_type === 'local_agent') {
      if (!this.info.subagents.some((s) => s.id === (message.tool_use_id ?? message.task_id))) {
        this.info.subagents.push({
          id: message.tool_use_id ?? message.task_id,
          description: message.description,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        this.saveInfo();
      }
      return undefined;
    }

    if (isTaskNotification(message) && !message.ambient) {
      const sub = this.info.subagents.find((s) => s.id === message.task_id);
      if (sub) {
        sub.status = message.status;
        sub.endedAt = new Date().toISOString();
        this.saveInfo();
      }
      return undefined;
    }

    if (isRateLimitEvent(message) && message.rate_limit_info.status === 'rejected' && message.rate_limit_info.resetsAt) {
      this.rejectedRateLimitResetAt = new Date(message.rate_limit_info.resetsAt * 1000).toISOString();
      return undefined;
    }

    if (isApiRetry(message)) {
      this.emitLog(`API ${message.error}, retrying (${message.attempt}/${message.max_retries})`);
      return undefined;
    }

    if (isResultMessage(message) && message.session_id) {
      this.info.sessionId = message.session_id;
    }
    return undefined;
  }

  private onToolUse(id: string, name: string, input: Record<string, unknown>, logPhase: TaskLogPhase, inSubagent: boolean, subphase?: string): void {
    const summary = summarizeToolInput(name, input);
    this.log.add(logPhase, 'tool_start', `${name}${summary ? `: ${summary}` : ''}`, {
      tool_name: name,
      tool_input: summary,
      tool_use_id: id,
      ...(subphase ? { subphase } : {}),
    });
    this.reportEditedFile(name, input);
    if (inSubagent) return;
    this.toolNames.set(id, name);
    this.emitLog(`${name}${summary ? ` ${summary}` : ''}`);

    if (name === 'Agent' || name === 'Task') {
      const description = typeof input.description === 'string' ? input.description : 'Subagent';
      this.subagentLabels.set(id, `Subagent: ${description}`);
      if (!this.info.subagents.some((s) => s.id === id)) {
        this.info.subagents.push({
          id,
          description,
          type: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        this.saveInfo();
      }
    } else if (name === 'TaskCreate') {
      this.pendingTaskCreates.set(id, {
        id: String(this.subtasks.length + this.pendingTaskCreates.size + 1),
        title: typeof input.subject === 'string' ? input.subject : 'Step',
        description: typeof input.description === 'string' ? input.description : '',
        status: 'pending',
      });
    } else if (name === 'TaskUpdate') {
      const taskId = String(input.taskId ?? input.id ?? '');
      const subtask = this.subtasks.find((s) => s.id === taskId);
      if (subtask) {
        const status = String(input.status ?? '');
        if (status === 'deleted') {
          this.subtasks = this.subtasks.filter((s) => s !== subtask);
        } else if (status === 'in_progress' || status === 'completed' || status === 'pending') {
          subtask.status = status;
        }
        if (typeof input.subject === 'string') subtask.title = input.subject;
        this.emitSubtasks();
      }
    }
  }

  /** Report a file the session (or one of its subagents) is editing inside the worktree */
  private reportEditedFile(name: string, input: Record<string, unknown>): void {
    if (!FILE_EDIT_TOOLS.has(name)) return;
    // `file_paths`: one patch touching several files (OMP)
    const targets = [input.file_path ?? input.notebook_path, ...(Array.isArray(input.file_paths) ? input.file_paths : [])];
    const files: string[] = [];
    for (const target of targets) {
      if (typeof target !== 'string' || !target) continue;
      // In WSL the session reports Linux paths (/mnt/c/...); compare them as host paths
      const hostTarget = toHostPath(target);
      const relative = path.relative(this.config.worktreePath, path.resolve(this.config.worktreePath, hostTarget));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const file = relative.split(path.sep).join('/');
      if (!files.includes(file)) files.push(file);
    }
    if (files.length > 0) this.callbacks.onFilesEdited?.(files);
  }

  private onToolResult(block: ClaudeToolResultBlock, logPhase: TaskLogPhase, inSubagent: boolean): void {
    const text = typeof block.content === 'string'
      ? block.content
      : (block.content ?? []).map((c) => c.text ?? '').join('\n');
    const name = this.toolNames.get(block.tool_use_id);
    if (inSubagent || !name) return;
    this.log.add(logPhase, 'tool_end', `${name} ${block.is_error ? 'failed' : 'done'}`, {
      tool_name: name,
      tool_use_id: block.tool_use_id,
      detail: text || undefined,
      collapsed: true,
    });

    if (name === 'Agent' || name === 'Task') {
      const sub = this.info.subagents.find((s) => s.id === block.tool_use_id);
      if (sub && sub.status === 'running' && !/running in the background|launched/i.test(text)) {
        sub.status = block.is_error ? 'failed' : 'completed';
        sub.endedAt = new Date().toISOString();
        this.saveInfo();
      }
    } else if (name === 'TaskCreate') {
      const pending = this.pendingTaskCreates.get(block.tool_use_id);
      this.pendingTaskCreates.delete(block.tool_use_id);
      if (pending && !block.is_error) {
        const idMatch = text.match(/#\s*(\d+)/) ?? text.match(/\b(?:id|task)\D{0,3}(\d+)/i);
        if (idMatch) pending.id = idMatch[1];
        this.subtasks.push(pending);
        this.emitSubtasks();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private hasCompleted(name: ClaudeRunPhaseName): boolean {
    return this.info.phases.some((p) => p.name === name && p.endedAt && !p.isError);
  }

  private beginPhase(name: ClaudeRunPhaseName, fields: Partial<ClaudeRunPhase>): ClaudeRunPhase {
    const phase: ClaudeRunPhase = { name, startedAt: new Date().toISOString(), ...fields };
    this.info.phases.push(phase);
    this.saveInfo();
    return phase;
  }

  private endPhase(phase: ClaudeRunPhase, fields: Partial<ClaudeRunPhase>, result?: ClaudeResultMessage): void {
    let costUsd = phase.costUsd;
    if (result?.total_cost_usd !== undefined) {
      // A resumed session reports what the whole session has cost, not what this `--resume` spent:
      // Claude Code restores the session's cost accounting along with its messages, so the figure
      // keeps climbing over the phases (the transcript's `cost-state` lines show the same running
      // total under one `startTime`, see `session-spending.ts`). This phase's share is therefore
      // the difference. Triage is left out because it runs as a session of its own.
      const earlier = this.costIsPerRun ? 0 : this.info.phases
        .filter((p) => p !== phase && p.name !== 'triage' && p.sessionId === (result.session_id ?? phase.sessionId))
        .reduce((sum, p) => sum + (p.costUsd ?? 0), 0);
      costUsd = Math.max(result.total_cost_usd - earlier, 0);
    }
    Object.assign(phase, {
      endedAt: new Date().toISOString(),
      ...(result ? {
        costUsd,
        durationMs: result.duration_ms,
        numTurns: result.num_turns,
        sessionId: result.session_id ?? phase.sessionId,
      } : {}),
    }, fields);
    this.updateTotalCost();
    this.saveInfo();
  }

  private updateTotalCost(): void {
    this.info.totalCostUsd = this.info.phases.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);
  }

  private rateLimited(name: ClaudeRunPhaseName, phase: ClaudeRunPhase, limit: { message: string; resetAt?: string }): TaskRunOutcome {
    const error = `Usage limit reached: ${limit.message}`;
    this.endPhase(phase, { isError: true, error });
    this.emitLog(error);
    this.log.add(name === 'validate' ? 'validation' : name === 'implement' || name === 'revise' ? 'coding' : 'planning', 'error', error);
    this.callbacks.onTaskEvent?.('RATE_LIMIT_HOLD', {
      resetAt: limit.resetAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      message: limit.message,
      phase: name === 'validate' ? 'qa_review' : name === 'plan' || name === 'triage' ? 'planning' : 'coding',
    });
    return { status: 'rate_limited', rateLimit: limit, error };
  }

  private failEvent(name: ClaudeRunPhaseName, error: string): void {
    if (name === 'plan' || name === 'triage') {
      this.callbacks.onTaskEvent?.('PLANNING_FAILED', { error, recoverable: true });
    } else if (name === 'validate') {
      this.callbacks.onTaskEvent?.('QA_AGENT_ERROR', { iteration: 1, consecutiveErrors: 1, error });
    } else {
      this.callbacks.onTaskEvent?.('CODING_FAILED', { subtaskId: '', error, attemptCount: 1 });
    }
  }

  private resetAt(resetText: string | null): string | undefined {
    if (!resetText) return undefined;
    return parseLimitResetTime(resetText)?.toISOString();
  }

  /** Commit changes Claude left uncommitted, so the review shows the full result */
  private async commitLeftovers(): Promise<void> {
    const cwd = this.config.worktreePath;
    try {
      // Generated folders (node_modules, .venv, dist, ...) are never staged, even without a .gitignore
      if (!(await stageTaskWork(cwd, ['.workbench']))) return;
      const title = this.info.triage?.title || this.config.title;
      await git(['commit', '-m', title, '--no-verify'], { cwd });
      this.emitLog('Committed remaining changes');
    } catch (error) {
      this.emitLog(`Could not commit remaining changes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitLog(line: string): void {
    this.callbacks.onLog?.(line);
  }

  private emitProgress(phase: ExecutionPhase, overall: number, message: string): void {
    this.callbacks.onProgress?.({
      phase,
      phaseProgress: 0,
      overallProgress: Math.round(overall * 100),
      message,
    });
  }

  private emitSubtasks(): void {
    this.callbacks.onSubtasks?.(this.subtasks.map((s) => ({ ...s })));
    const active = this.subtasks.find((s) => s.status === 'in_progress');
    if (active) {
      const done = this.subtasks.filter((s) => s.status === 'completed').length;
      this.callbacks.onProgress?.({
        phase: 'coding',
        phaseProgress: Math.round((done / Math.max(this.subtasks.length, 1)) * 100),
        overallProgress: 20 + Math.round((done / Math.max(this.subtasks.length, 1)) * 60),
        message: active.title,
        currentSubtask: active.id,
      });
    }
  }

  private saveInfo(): void {
    this.info.updatedAt = new Date().toISOString();
    this.callbacks.onRunInfo?.(structuredClone(this.info));
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flushInfo(), 300);
  }

  private flushInfo(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    writeFileSafe(this.runFile, JSON.stringify(this.info, null, 2));
  }
}

// =============================================================================
// Persistence helpers
// =============================================================================

/** Where Claude Code runs now */
function currentRuntime(): ClaudeRuntime {
  return getWslInfo() ? 'wsl' : 'native';
}

/** Claude Code's default config dir (`~/.claude`) as a host path: the Linux home's in WSL */
function defaultClaudeConfigDir(): string {
  const wsl = getWslInfo();
  return wsl ? toHostPath(path.posix.join(wsl.home, '.claude')) : path.join(os.homedir(), '.claude');
}

/**
 * Copy a session transcript (`<configDir>/projects/<project>/<sessionId>.jsonl`) to another
 * Claude config dir, so the session can be resumed on a different profile
 */
function copySessionTranscript(sessionId: string, fromConfigDir: string, toConfigDir: string): void {
  try {
    const projectsDir = path.join(fromConfigDir, 'projects');
    for (const project of readdirSync(projectsDir)) {
      const source = path.join(projectsDir, project, `${sessionId}.jsonl`);
      if (!existsSync(source)) continue;
      const targetDir = path.join(toConfigDir, 'projects', project);
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(source, path.join(targetDir, `${sessionId}.jsonl`));
      return;
    }
  } catch (error) {
    console.warn('[ClaudeTaskRun] Could not copy the session transcript to the new profile:', error);
  }
}

function formatDelay(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function writeFileSafe(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, file);
  } catch (error) {
    console.error('[ClaudeTaskRun] Failed to write', file, error);
  }
}

/** Read a task's run state (`claude_run.json`), or null when the task never ran */
export function loadClaudeRunInfo(specDir: string): ClaudeRunInfo | null {
  const file = path.join(specDir, CLAUDE_RUN_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ClaudeRunInfo;
    if (parsed?.version !== 1 || !Array.isArray(parsed.phases)) return null;
    parsed.subagents = parsed.subagents ?? [];
    parsed.totalCostUsd = parsed.totalCostUsd ?? 0;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether a run went all the way through: its last step is a finished validation, or a finished
 * implementation/revision when validation is off. Starting such a task again begins a new run.
 */
export function isClaudeRunFinished(info: ClaudeRunInfo | null, validation: boolean): boolean {
  const last = info?.phases.at(-1);
  if (!last?.endedAt || last.isError) return false;
  if (last.name === 'validate') return true;
  return !validation && (last.name === 'implement' || last.name === 'revise');
}

/** Forget a task's run state so the next start triages and runs from scratch */
export function resetClaudeRunInfo(specDir: string): void {
  writeFileSafe(path.join(specDir, CLAUDE_RUN_FILE), JSON.stringify({
    version: 1,
    phases: [],
    subagents: [],
    totalCostUsd: 0,
    updatedAt: new Date().toISOString(),
  } satisfies ClaudeRunInfo, null, 2));
}

function normalizeValidation(structured: unknown, fallbackText?: string): ValidationReport {
  const raw = (structured ?? {}) as Partial<ValidationReport>;
  const status = raw.status === 'passed' || raw.status === 'failed' || raw.status === 'partial' ? raw.status : 'partial';
  return {
    status,
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : (fallbackText ?? ''),
    checks: Array.isArray(raw.checks) ? raw.checks.filter((c) => c && typeof c.name === 'string') : [],
    findings: Array.isArray(raw.findings) ? raw.findings.filter((f) => f && typeof f.description === 'string') : [],
  };
}
