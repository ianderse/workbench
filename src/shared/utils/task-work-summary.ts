/**
 * Pure helpers behind the "What was done" panel of a task in Human Review: the AI review verdict,
 * check counts, open findings by severity, effort (time, cost, models) and per-file change stats.
 * The panel turns this data into translated text.
 */

import type { ClaudeRunInfo, ValidationFinding } from '../types/claude-code';
import type { TaskChangeFile } from '../types/task';
import { getRunPhaseDurationMs } from './claude-run';

export type ReviewOutcome =
  | { kind: 'passed'; rounds: number; maxRounds: number }
  | { kind: 'failed'; rounds: number; maxRounds: number }
  | { kind: 'none' };

export interface ChecksOutcome {
  total: number;
  passed: number;
  failing: string[];
}

export interface FindingsOutcome {
  /** Findings the agent left open, most severe first */
  open: ValidationFinding[];
  critical: number;
  major: number;
  minor: number;
}

export interface EffortOutcome {
  /** Sum of the steps' times, 0 when none is recorded */
  durationMs: number;
  costUsd: number;
  /** Each model with the steps it ran, in the order first used (triage is not listed) */
  models: { model: string; phases: string[] }[];
}

export interface WorkSummary {
  /** The agent's final answer, or the validation report's summary; null when neither exists */
  summary: string | null;
  review: ReviewOutcome;
  /** null when no validation report exists */
  checks: ChecksOutcome | null;
  findings: FindingsOutcome;
  effort: EffortOutcome;
}

const SEVERITY_ORDER: Record<ValidationFinding['severity'], number> = { critical: 0, major: 1, minor: 2 };

export function reviewOutcome(run: ClaudeRunInfo | undefined): ReviewOutcome {
  const verdict = run?.reviewVerdict;
  if (!verdict) return { kind: 'none' };
  return { kind: verdict.status, rounds: verdict.rounds, maxRounds: verdict.maxRounds };
}

export function checksOutcome(run: ClaudeRunInfo | undefined): ChecksOutcome | null {
  const checks = run?.validation?.checks;
  if (!checks || checks.length === 0) return null;
  return {
    total: checks.length,
    passed: checks.filter((check) => check.passed).length,
    failing: checks.filter((check) => !check.passed).map((check) => check.name),
  };
}

export function findingsOutcome(run: ClaudeRunInfo | undefined): FindingsOutcome {
  const open = (run?.validation?.findings ?? [])
    .filter((finding) => !finding.fixed)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    open,
    critical: open.filter((f) => f.severity === 'critical').length,
    major: open.filter((f) => f.severity === 'major').length,
    minor: open.filter((f) => f.severity === 'minor').length,
  };
}

export function effortOutcome(run: ClaudeRunInfo | undefined): EffortOutcome {
  const phases = run?.phases ?? [];
  let durationMs = 0;
  for (const phase of phases) durationMs += getRunPhaseDurationMs(phase) ?? 0;
  const models: EffortOutcome['models'] = [];
  for (const phase of phases) {
    if (phase.name === 'triage' || !phase.model) continue;
    const entry = models.find((m) => m.model === phase.model);
    if (!entry) models.push({ model: phase.model, phases: [phase.name] });
    else if (!entry.phases.includes(phase.name)) entry.phases.push(phase.name);
  }
  return { durationMs, costUsd: run?.totalCostUsd ?? 0, models };
}

export function buildWorkSummary(run: ClaudeRunInfo | undefined): WorkSummary {
  const summary = run?.summary?.trim() || run?.validation?.summary?.trim() || null;
  return {
    summary,
    review: reviewOutcome(run),
    checks: checksOutcome(run),
    findings: findingsOutcome(run),
    effort: effortOutcome(run),
  };
}

/** Whether there is anything worth a "What was done" panel */
export function hasWorkSummary(run: ClaudeRunInfo | undefined): boolean {
  const work = buildWorkSummary(run);
  return work.summary !== null || work.checks !== null || work.review.kind !== 'none' || work.effort.durationMs > 0;
}

/** Parse `git diff --numstat` output ("12\t3\tpath", binary files "-\t-\tpath") */
export function parseNumstat(output: string): TaskChangeFile[] {
  const files: TaskChangeFile[] = [];
  for (const line of output.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trimEnd());
    if (!match) continue;
    files.push({
      path: match[3],
      additions: match[1] === '-' ? 0 : parseInt(match[1], 10),
      deletions: match[2] === '-' ? 0 : parseInt(match[2], 10),
    });
  }
  return files;
}

/** The files with the most changed lines first, and how many are left out beyond `limit` */
export function topChangedFiles(files: TaskChangeFile[], limit: number): { shown: TaskChangeFile[]; more: number } {
  const sorted = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return { shown: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}
