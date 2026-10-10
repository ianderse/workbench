/**
 * Claude Code task runner
 * =======================
 *
 * Runs one Auto Claude task through the Claude Code CLI, in the task's git worktree:
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
import { execFile } from 'child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { resolveClaudeEnv } from './env';
import { startClaudeProcess, type ClaudeProcessHandle } from './process';
import { buildMcpConfig } from './mcp-config';
import { triageTask, fixedTriage, applyPlanningPolicy } from './triage';
import { TaskLogWriter, summarizeToolInput } from './task-log';
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
  ClaudeRunInfo,
  ClaudeRunPhase,
  ClaudeRunPhaseName,
  TaskTriage,
  ValidationReport,
} from '../../shared/types/claude-code';
import type { McpConnectorSettings } from '../../shared/types/settings';
import type { ExecutionPhase } from '../../shared/constants/phase-protocol';
import type { SubtaskStatus, TaskLogPhase } from '../../shared/types/task';

const execFileAsync = promisify(execFile);

export const CLAUDE_RUN_FILE = 'claude_run.json';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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
  /** Prompt section pointing Claude Code at the project's Graphify memory graph */
  graphifyPrompt?: string;
  /** Extra environment (e.g. GRAPHIFY_OUT, PATH with the graphify CLI) */
  extraEnv?: Record<string, string>;
  /** start: new or continued run; revise: apply reviewer feedback */
  mode: 'start' | 'revise';
  feedback?: string;
  feedbackAttachments?: TaskAttachment[];
  /** Claude profile to use (undefined = best available) */
  profileId?: string;
}

export interface TaskRunProgress {
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
}

export type TaskRunStatus = 'completed' | 'failed' | 'rate_limited' | 'auth_failed' | 'stopped';

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

function buildSystemPrompt(config: TaskRunConfig, specDirRelative: string): string {
  const sections = [
    `You are running autonomously inside Auto Claude, a desktop app that hands coding tasks to Claude Code. Nobody watches this session live and nobody can answer questions: make reasonable assumptions, state them in your final summary, and keep going.`,
    config.isolated === false
      ? `## Environment
- Your working directory is the user's project checkout on branch \`${config.branch}\` (this task runs without a separate worktree). Keep changes focused on the task.
- Never push, force-push, rewrite history, publish packages or deploy.
- Auto Claude keeps its own task files in \`${specDirRelative}\`. Don't modify or commit them.`
      : `## Environment
- Your working directory is an isolated git worktree on branch \`${config.branch}\`, created from \`${config.baseBranch}\`. Edits here never touch the user's main checkout. Stay inside this worktree.
- Permission checks are off because of that isolation. Still never push, force-push, rewrite the history of \`${config.baseBranch}\`, publish packages, deploy, or change anything outside the worktree.
- Auto Claude keeps its own task files in \`${specDirRelative}\`. Don't modify or commit them.`,
    `## How to work
- Follow the project's CLAUDE.md, conventions and existing patterns. Keep the change focused on the task.
- Track work with the task list (TaskCreate / TaskUpdate) only when it has several distinct steps worth tracking; skip it for small changes.
- Use subagents only when they help: broad searches whose raw output you don't need, or independent investigations that can run in parallel. Do the implementation itself in this conversation.
- Use skills and MCP tools when they fit the task.
- Verify your work with the project's own checks (tests, type checker, linter, build) for the code you changed, and fix failures you caused. Show evidence rather than asserting success.
- When the work is done, commit it in this worktree with a descriptive message. Don't push.
- End with a short summary for the reviewer: what changed, how you verified it, and any assumptions or follow-ups.`,
  ];
  if (config.graphifyPrompt) sections.push(config.graphifyPrompt);
  if (config.settings.extraInstructions?.trim()) {
    sections.push(`## Additional instructions\n${config.settings.extraInstructions.trim()}`);
  }
  return sections.join('\n\n');
}

function taskBlock(config: TaskRunConfig): string {
  return `<task title="${config.title.replace(/"/g, "'")}">\n${config.description}\n</task>`;
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
  private saveTimer: NodeJS.Timeout | null = null;

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

  private async runTriage(): Promise<TaskRunOutcome | null> {
    const { settings } = this.config;
    this.emitProgress('planning', 0.05, 'Assessing the task');
    this.log.startPhase('planning', 'Assessing the task');
    const phase = this.beginPhase('triage', { model: settings.triageModel, effort: 'low' });

    let triage: TaskTriage;
    let triageCost: number | undefined;
    if (settings.triage === 'fixed') {
      triage = fixedTriage(settings, this.config.title, 'fixed', 'Fixed model and effort from Settings > Claude Code');
    } else {
      try {
        ({ triage, costUsd: triageCost } = await triageTask({
          description: this.config.description,
          cwd: this.config.worktreePath,
          attachmentNames: this.config.attachments.map((a) => a.filename),
          settings,
          abortSignal: this.abortController.signal,
          profileId: this.config.profileId,
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
    triage = applyPlanningPolicy(triage, settings);
    this.info.triage = triage;
    this.endPhase(phase, triageCost !== undefined ? { costUsd: triageCost } : {});
    this.updateTotalCost();
    this.log.add('planning', 'info',
      `Model ${triage.model}, effort ${triage.effort}, ${triage.needsPlan ? 'plan first' : 'no plan'} (${triage.scope})`,
      { detail: triage.reasoning || undefined });
    this.emitLog(`Triage: ${triage.model} / ${triage.effort} / ${triage.needsPlan ? 'plan first' : 'no plan'}. ${triage.reasoning}`);
    this.saveInfo();
    return null;
  }

  /** Run a Claude Code session step; returns an outcome when the run must stop */
  private async runSessionPhase(name: Exclude<ClaudeRunPhaseName, 'triage'>): Promise<TaskRunOutcome | null> {
    const triage = this.info.triage ?? fixedTriage(this.config.settings, this.config.title, 'fallback', 'No triage recorded');
    const model = name === 'plan' ? (triage.model === 'fable' ? 'fable' : 'opus') : triage.model;
    const effort: ClaudeEffort = name === 'plan' && (triage.effort === 'low' || triage.effort === 'medium') ? 'high' : triage.effort;
    const logPhase: TaskLogPhase = name === 'plan' ? 'planning' : name === 'validate' ? 'validation' : 'coding';

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
      this.log.startPhase('planning', `${label} (${model}, ${effort})`);
    } else if (name === 'implement' || name === 'revise') {
      this.callbacks.onTaskEvent?.('CODING_STARTED', { subtaskId: '', subtaskDescription: label });
      this.emitProgress('coding', 0.2, label);
      this.log.startPhase('coding', `${label} (${model}, ${effort})`);
    } else {
      this.callbacks.onTaskEvent?.('QA_STARTED', { iteration: 1, maxIterations: 1 });
      this.emitProgress('qa_review', 0.85, label);
      this.log.startPhase('validation', `${label} (${model}, ${effort})`);
    }

    const sessionId = resumeSessionId ?? randomUUID();
    const phase = this.beginPhase(name, {
      model,
      effort,
      permissionMode: name === 'plan' ? 'plan' : this.config.isolated === false ? 'auto' : 'bypassPermissions',
      sessionId,
    });
    if (!this.info.sessionId) this.info.sessionId = sessionId;
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
      this.log.endPhase(logPhase, false, 'Stopped');
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
        || (result?.subtype === 'error_max_budget_usd' ? 'The task reached its budget limit (Settings > Claude Code)' : '')
        || result?.result
        || 'Claude Code stopped with an error';
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

  private buildInput(name: Exclude<ClaudeRunPhaseName, 'triage'>, continuing: boolean, resume: boolean): ClaudeUserContentBlock[] {
    const triage = this.info.triage;
    const blocks: ClaudeUserContentBlock[] = [];
    let text: string;

    switch (name) {
      case 'plan':
        text = `${taskBlock(this.config)}

Explore the codebase as needed and produce an implementation plan for this task. Don't change any files yet.
The plan should name the files to change, the approach and why, edge cases, and how to verify the result (${verificationHint(triage)}).`;
        break;
      case 'implement':
        if (continuing) {
          text = `Continue the task from where you left off. Check \`git status\` and \`git log\` to see what is already done, then finish the work.`;
        } else if (this.info.plan) {
          text = `The plan is approved. Implement it now, verify it with ${verificationHint(triage)}, and commit the result.`;
        } else {
          text = `${taskBlock(this.config)}

Implement this task. Verify it with ${verificationHint(triage)}, then commit the result.`;
        }
        break;
      case 'validate':
        text = `Before handing this off, validate the work:
1. Run ${verificationHint(triage)}. Fix failures your change caused.
2. Review the full change against \`${this.config.baseBranch}\` (\`git diff ${this.config.baseBranch}...HEAD\` plus any uncommitted changes) with fresh eyes. Use the /code-review skill if it's available; otherwise use a subagent that sees only the diff and the task. Fix only findings that affect correctness or the task's requirements; don't gold-plate.
3. Commit any remaining changes.
Then return the report: status "passed" when the change works and the checks pass, "partial" when some checks couldn't run, "failed" when something is still broken.`;
        break;
      case 'revise':
        text = `${resume ? '' : `${taskBlock(this.config)}\n\n`}The reviewer requested changes:

<feedback>
${this.config.feedback ?? ''}
</feedback>

Apply them, verify with ${verificationHint(triage)}, and commit the result.`;
        break;
    }
    blocks.push({ type: 'text', text });

    // Task images go with the session's first turn; feedback images with the revision
    const images = name === 'revise'
      ? [...(resume ? [] : this.config.attachments), ...(this.config.feedbackAttachments ?? [])]
      : resume ? [] : this.config.attachments;
    for (const attachment of images) {
      try {
        const data = readFileSync(attachment.path);
        if (data.byteLength > MAX_IMAGE_BYTES) continue;
        blocks.push({ type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: data.toString('base64') } });
      } catch {
        this.emitLog(`Could not attach ${attachment.filename}`);
      }
    }
    return blocks;
  }

  private async runClaude(params: {
    name: Exclude<ClaudeRunPhaseName, 'triage'>;
    model: string;
    effort: ClaudeEffort;
    sessionId: string;
    resume: boolean;
    input: ClaudeUserContentBlock[];
    jsonSchema?: Record<string, unknown>;
    logPhase: TaskLogPhase;
  }): Promise<PhaseResult> {
    if (this.stopped) return { stopped: true };
    const { settings } = this.config;
    const { command, env } = await resolveClaudeEnv({
      profileId: this.config.profileId,
      extraEnv: {
        ...(this.config.extraEnv ?? {}),
        // Make the task list available on every model, so Claude can track multi-step work
        // and the app can show it as the task's subtasks
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      },
    });

    const specDirRelative = path.join('.auto-claude', 'specs', this.config.specId);
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', params.model,
      '--effort', params.effort,
      '--permission-prompts', 'none',
      '--append-system-prompt', buildSystemPrompt(this.config, specDirRelative),
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
    if (settings.maxBudgetUsd && settings.maxBudgetUsd > 0) args.push('--max-budget-usd', String(settings.maxBudgetUsd));
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
      const error = outcome.stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${outcome.exitCode}`;
      return { stopped: false, error };
    }
    return { result, stopped: false };
  }

  /** Apply one stream message; returns a signal for rate-limit or auth problems */
  private handleMessage(message: ClaudeStreamMessage, logPhase: TaskLogPhase): 'rate_limit' | 'auth' | undefined {
    if (isInitMessage(message)) {
      this.info.init = {
        claudeCodeVersion: message.claude_code_version,
        model: message.model,
        permissionMode: message.permissionMode,
        cwd: message.cwd,
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
      ...(subphase ? { subphase } : {}),
    });
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

  private onToolResult(block: ClaudeToolResultBlock, logPhase: TaskLogPhase, inSubagent: boolean): void {
    const text = typeof block.content === 'string'
      ? block.content
      : (block.content ?? []).map((c) => c.text ?? '').join('\n');
    const name = this.toolNames.get(block.tool_use_id);
    if (inSubagent || !name) return;
    this.log.add(logPhase, 'tool_end', `${name} ${block.is_error ? 'failed' : 'done'}`, {
      tool_name: name,
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
      // A resumed session reports its cumulative cost: this phase's share is the difference
      const earlier = this.info.phases
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
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--', '.', ':(exclude).auto-claude'], { cwd });
      if (!stdout.trim()) return;
      await execFileAsync('git', ['add', '-A', '--', '.', ':(exclude).auto-claude'], { cwd });
      const title = this.info.triage?.title || this.config.title;
      await execFileAsync('git', ['commit', '-m', title, '--no-verify'], { cwd });
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
