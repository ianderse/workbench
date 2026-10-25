/**
 * AI review loop: the pure rules
 * ==============================
 *
 * After a validation (AI review) the task either passes the gate or is sent back to fix what the
 * reviewer found, up to `aiReviewRounds` reviews in total. This module holds the gate, the
 * feedback for a fix round and the summary a person gets when the last round still fails. The
 * task runner drives the loop; nothing here touches the disk or a process.
 */

import type {
  ReviewFailureSummary,
  ReviewRound,
  ReviewRoundFinding,
  ValidationReport,
} from '../types/claude-code';

export interface ReviewGateResult {
  passes: boolean;
  /** Unfixed blocker and major findings (critical counts as blocker) */
  openFindings: ReviewRoundFinding[];
  /** Checks that did not pass */
  failingChecks: Array<{ name: string; command?: string; details?: string }>;
  /** Blocker and major findings the report marks as fixed */
  fixedFindings: number;
}

function severityOf(raw: string): ReviewRoundFinding['severity'] {
  const value = raw.toLowerCase();
  if (value === 'blocker' || value === 'critical') return 'blocker';
  if (value === 'major' || value === 'high') return 'major';
  return 'minor';
}

/**
 * The review gate. A report fails it when its status is `failed`, when a blocker or major finding
 * is still open, or when a check failed. `partial` with only minor findings passes.
 */
export function evaluateReviewGate(report: ValidationReport): ReviewGateResult {
  const normalised = report.findings.map((f) => ({
    fixed: f.fixed === true,
    finding: {
      severity: severityOf(String(f.severity)),
      description: f.description,
      ...(f.file ? { file: f.file } : {}),
      ...(typeof f.line === 'number' ? { line: f.line } : {}),
    } satisfies ReviewRoundFinding,
  }));
  const serious = normalised.filter((f) => f.finding.severity !== 'minor');
  const openFindings = serious.filter((f) => !f.fixed).map((f) => f.finding);
  const failingChecks = report.checks
    .filter((c) => !c.passed)
    .map((c) => ({ name: c.name, ...(c.command ? { command: c.command } : {}), ...(c.details ? { details: c.details } : {}) }));
  return {
    passes: report.status !== 'failed' && openFindings.length === 0 && failingChecks.length === 0,
    openFindings,
    failingChecks,
    fixedFindings: serious.length - openFindings.length,
  };
}

export function formatFindingLocation(finding: Pick<ReviewRoundFinding, 'file' | 'line'>): string {
  if (!finding.file) return '';
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

function findingKey(f: ReviewRoundFinding): string {
  return `${f.file ?? ''}|${f.description.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;
}

/** Counts for a round against the round before it (round 1: what the review itself fixed) */
export function compareWithPreviousRound(
  previousOpen: readonly ReviewRoundFinding[] | undefined,
  gate: ReviewGateResult,
): { fixedCount: number; newCount: number } {
  if (!previousOpen) return { fixedCount: gate.fixedFindings, newCount: 0 };
  const before = new Set(previousOpen.map(findingKey));
  const stillOpen = gate.openFindings.filter((f) => before.has(findingKey(f))).length;
  return {
    fixedCount: Math.max(0, previousOpen.length - stillOpen),
    newCount: gate.openFindings.length - stillOpen,
  };
}

/** The feedback a fix round gets: the open findings and failing checks of the review */
export function buildFixFeedback(gate: ReviewGateResult, report: ValidationReport): string {
  const lines: string[] = [];
  gate.openFindings.forEach((f, i) => {
    const where = formatFindingLocation(f);
    lines.push(`${i + 1}. ${f.severity.toUpperCase()}${where ? ` [${where}]` : ''}: ${f.description}`);
  });
  gate.failingChecks.forEach((c) => {
    lines.push(`- Failing check "${c.name}"${c.command ? ` (${c.command})` : ''}${c.details ? `: ${c.details}` : ''}`);
  });
  if (lines.length === 0 && report.summary.trim()) lines.push(`The review failed: ${report.summary.trim()}`);
  return lines.join('\n');
}

/** The first `max` sentences of a text */
export function firstSentences(text: string, max = 3): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const sentences = cleaned.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [cleaned];
  return sentences.slice(0, max).map((s) => s.trim()).join(' ');
}

/** One progress line per round, so a person can see progress versus going in circles */
export function describeReviewRound(round: ReviewRound): string {
  const open = round.openFindings.length;
  const checks = round.failingChecks.length;
  const checkNote = checks > 0 ? `, ${checks} failing ${checks === 1 ? 'check' : 'checks'}` : '';
  if (round.round === 1) {
    const found = open + round.fixedCount;
    if (found === 0) return `Round 1: no blocker or major findings${checkNote}`;
    return `Round 1: ${found} blocker/major found${round.fixedCount > 0 ? `, ${round.fixedCount} fixed during the review` : ''}${open > 0 ? `, ${open} still open` : ''}${checkNote}`;
  }
  if (open === 0) {
    return `Round ${round.round}: ${round.fixedCount > 0 ? `fixed ${round.fixedCount}, none` : 'none'} still open${checkNote}`;
  }
  return `Round ${round.round}: fixed ${round.fixedCount}, ${open} still open${round.newCount > 0 ? ` (${round.newCount} new)` : ''}${checkNote}`;
}

/** What a person sees when the task still fails AI review after its last round */
export function buildReviewFailureSummary(rounds: readonly ReviewRound[], lastReport: ValidationReport): ReviewFailureSummary {
  const gate = evaluateReviewGate(lastReport);
  const last = rounds[rounds.length - 1];
  let reason = firstSentences(lastReport.summary, 3);
  if (!reason) {
    reason = gate.openFindings.length > 0
      ? `${gate.openFindings.length} blocker or major ${gate.openFindings.length === 1 ? 'finding is' : 'findings are'} still open.`
      : 'The review did not pass.';
  }
  return {
    reason,
    openFindings: last ? [...last.openFindings] : gate.openFindings,
    failingChecks: gate.failingChecks.map((c) => c.name),
    roundLines: rounds.map(describeReviewRound),
  };
}

/** Lines for the QA_FAILED event's `issues` */
export function summaryToIssues(summary: ReviewFailureSummary): string[] {
  return [
    summary.reason,
    ...summary.openFindings.map((f) => {
      const where = formatFindingLocation(f);
      return `${f.severity}${where ? ` ${where}` : ''}: ${f.description}`;
    }),
    ...summary.failingChecks.map((name) => `Failing check: ${name}`),
    ...summary.roundLines,
  ];
}
