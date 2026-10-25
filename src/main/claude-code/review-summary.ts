/**
 * Reviewer summary generation
 * ===========================
 *
 * One tool-less one-shot call (`runClaudeText`) that turns a finished run (the ticket, the agent's
 * final notes, the validation report, the AI review verdict and a diff stat) into a plain-language
 * `ReviewSummary` for the person reviewing the ticket. It runs in the background after a run ends,
 * and once on demand for tasks that finished before this existed. A failure is logged and returns
 * null: the panel then falls back to the agent's own notes.
 */

import { runClaudeText } from './run-text';
import { appLog } from '../app-logger';
import { ompRoleForJob } from '../agent-backend/omp-args';
import type { AgentBackendKind } from '../../shared/types/agent-backend';
import type { ClaudeRunInfo, ReviewSummary } from '../../shared/types/claude-code';
import {
  REVIEW_SUMMARY_SCHEMA,
  REVIEW_SUMMARY_SYSTEM_PROMPT,
  buildReviewSummaryPrompt,
  parseReviewSummaryReply,
  type ReviewSummaryInput,
} from '../../shared/utils/review-summary';

/** Local models are slow; one-shot OMP runs get five times this */
const SUMMARY_TIMEOUT_MS = 10 * 60 * 1000;

export interface GenerateReviewSummaryParams {
  info: ClaudeRunInfo;
  title: string;
  request: string;
  changes?: ReviewSummaryInput['changes'];
  backend?: AgentBackendKind;
  /** Project directory (for the usage ledger) */
  projectPath: string;
  projectId?: string;
  taskId: string;
  abortSignal?: AbortSignal;
}

/** The summary for a run, or null when the model call fails or answers with nothing usable */
export async function generateReviewSummary(params: GenerateReviewSummaryParams): Promise<ReviewSummary | null> {
  const { info } = params;
  const prompt = buildReviewSummaryPrompt({
    title: params.title,
    request: params.request,
    plan: info.plan,
    agentSummary: info.summary,
    validation: info.validation,
    verdict: info.reviewVerdict,
    changes: params.changes,
  });
  try {
    const result = await runClaudeText({
      prompt,
      systemPrompt: REVIEW_SUMMARY_SYSTEM_PROMPT,
      model: 'sonnet',
      ompRole: ompRoleForJob('utility'),
      jsonSchema: REVIEW_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      backend: params.backend,
      cwd: params.projectPath,
      usage: { job: 'summary', projectPath: params.projectPath, projectId: params.projectId, taskId: params.taskId },
      timeoutMs: SUMMARY_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    const summary = parseReviewSummaryReply(result.structured, result.text);
    if (!summary) appLog.warn(`[ReviewSummary] ${params.taskId}: the model answered with nothing usable`);
    return summary;
  } catch (error) {
    appLog.warn(`[ReviewSummary] ${params.taskId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Summaries being written, by `<project id>:<task spec id>`, so a second request joins the first */
const inFlight = new Map<string, Promise<ReviewSummary | null>>();

/** Run `make` unless a summary for `key` is already being written; then share that one */
export function trackReviewSummary(key: string, make: () => Promise<ReviewSummary | null>): Promise<ReviewSummary | null> {
  const running = inFlight.get(key);
  if (running) return running;
  const promise = make().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
