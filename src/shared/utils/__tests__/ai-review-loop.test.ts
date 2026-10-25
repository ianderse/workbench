import { describe, it, expect } from 'vitest';
import type { ReviewRound, ValidationReport } from '../../types/claude-code';
import {
  buildFixFeedback,
  buildReviewFailureSummary,
  compareWithPreviousRound,
  describeReviewRound,
  evaluateReviewGate,
  firstSentences,
  summaryToIssues,
} from '../ai-review-loop';

function report(overrides: Partial<ValidationReport> = {}): ValidationReport {
  return { status: 'passed', summary: 'ok', checks: [], findings: [], ...overrides };
}

describe('evaluateReviewGate', () => {
  it('passes a clean report', () => {
    expect(evaluateReviewGate(report()).passes).toBe(true);
  });

  it('fails on status failed', () => {
    expect(evaluateReviewGate(report({ status: 'failed' })).passes).toBe(false);
  });

  it('passes partial with only minor or fixed findings', () => {
    const gate = evaluateReviewGate(report({
      status: 'partial',
      findings: [
        { severity: 'minor', description: 'nit', fixed: false },
        { severity: 'major', description: 'done', fixed: true },
      ],
    }));
    expect(gate.passes).toBe(true);
    expect(gate.fixedFindings).toBe(1);
  });

  it('fails on an open major or critical finding and normalises critical to blocker', () => {
    const gate = evaluateReviewGate(report({
      status: 'partial',
      findings: [
        { severity: 'critical', description: 'crash', fixed: false, file: 'a.ts', line: 3 },
        { severity: 'major', description: 'bug', fixed: false },
      ],
    }));
    expect(gate.passes).toBe(false);
    expect(gate.openFindings.map((f) => f.severity)).toEqual(['blocker', 'major']);
  });

  it('fails on a failing check', () => {
    const gate = evaluateReviewGate(report({ checks: [{ name: 'tests', command: 'npm test', passed: false }] }));
    expect(gate.passes).toBe(false);
    expect(gate.failingChecks).toEqual([{ name: 'tests', command: 'npm test' }]);
  });
});

describe('fix feedback and round comparison', () => {
  it('lists findings with locations and failing checks', () => {
    const r = report({
      status: 'failed',
      findings: [{ severity: 'major', description: 'Off by one', fixed: false, file: 'src/a.ts', line: 4 }],
      checks: [{ name: 'tests', command: 'npm test', passed: false, details: '2 failed' }],
    });
    const text = buildFixFeedback(evaluateReviewGate(r), r);
    expect(text).toContain('1. MAJOR [src/a.ts:4]: Off by one');
    expect(text).toContain('Failing check "tests" (npm test): 2 failed');
  });

  it('counts fixed, still open and new findings against the round before', () => {
    const f = (description: string) => ({ severity: 'major' as const, description, file: 'a.ts' });
    const gate = evaluateReviewGate(report({
      status: 'partial',
      findings: [
        { severity: 'major', description: 'A', fixed: false, file: 'a.ts' },
        { severity: 'major', description: 'Z', fixed: false, file: 'a.ts' },
      ],
    }));
    expect(compareWithPreviousRound([f('A'), f('B'), f('C')], gate)).toEqual({ fixedCount: 2, newCount: 1 });
    expect(compareWithPreviousRound(undefined, gate)).toEqual({ fixedCount: 0, newCount: 0 });
  });
});

describe('failure summary', () => {
  const round = (n: number, open: number, fixedCount: number, newCount = 0): ReviewRound => ({
    round: n,
    status: 'partial',
    summary: 's',
    openFindings: Array.from({ length: open }, (_, i) => ({ severity: 'major' as const, description: `F${i}`, file: 'a.ts', line: i + 1 })),
    failingChecks: [],
    fixedCount,
    newCount,
    startedAt: 'x',
    endedAt: 'y',
  });

  it('describes progress per round', () => {
    expect(describeReviewRound(round(1, 4, 0))).toBe('Round 1: 4 blocker/major found, 4 still open');
    expect(describeReviewRound(round(2, 1, 3))).toBe('Round 2: fixed 3, 1 still open');
    expect(describeReviewRound(round(3, 1, 0, 1))).toBe('Round 3: fixed 0, 1 still open (1 new)');
    expect(describeReviewRound(round(2, 0, 2))).toBe('Round 2: fixed 2, none still open');
  });

  it('builds reason, open findings, failing checks and round lines', () => {
    const last = report({
      status: 'failed',
      summary: 'First. Second. Third. Fourth.',
      checks: [{ name: 'build', passed: false }],
    });
    const summary = buildReviewFailureSummary([round(1, 4, 0), round(2, 1, 3)], last);
    expect(summary.reason).toBe('First. Second. Third.');
    expect(summary.openFindings).toHaveLength(1);
    expect(summary.failingChecks).toEqual(['build']);
    expect(summary.roundLines).toEqual(['Round 1: 4 blocker/major found, 4 still open', 'Round 2: fixed 3, 1 still open']);
    const issues = summaryToIssues(summary);
    expect(issues[0]).toBe('First. Second. Third.');
    expect(issues).toContain('major a.ts:1: F0');
    expect(issues).toContain('Failing check: build');
  });

  it('falls back to a generic reason without a summary', () => {
    expect(buildReviewFailureSummary([round(1, 2, 0)], report({ status: 'failed', summary: '' })).reason).toBe('The review did not pass.');
  });

  it('cuts text to sentences', () => {
    expect(firstSentences('One. Two! Three? Four.', 2)).toBe('One. Two!');
    expect(firstSentences('', 3)).toBe('');
  });
});
