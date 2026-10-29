import { describe, expect, it } from 'vitest';
import { countFindings, formatReviewDiff, formatReviewForValidation, normalizeReview } from '../review-diff';

const fileDiff = (name: string, body: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${body}\n+${body}x\n`;

describe('formatReviewDiff', () => {
  it('keeps whole files within the budget and names the ones left out', () => {
    const diff = fileDiff('a.ts', 'a'.repeat(100)) + fileDiff('b.ts', 'b'.repeat(500));
    const text = formatReviewDiff({ stat: ' 2 files changed', diff, untracked: [] }, 300);
    expect(text).toContain('diff --git a/a.ts');
    expect(text).not.toContain('diff --git a/b.ts');
    expect(text).toContain('not shown, read them with your tools if they matter: b.ts');
  });

  it('shows new files, cutting long ones', () => {
    const text = formatReviewDiff({ stat: '', diff: '', untracked: [{ path: 'n.ts', content: 'x'.repeat(9000) }, { path: 'img.png', content: null }] });
    expect(text).toContain('New file n.ts:');
    expect(text).toContain('more characters');
    expect(text).toContain('New file (binary or unreadable, not shown): img.png');
  });
});

describe('review findings', () => {
  it('normalizes structured output and counts severities', () => {
    const report = normalizeReview({
      summary: ' ok ',
      findings: [{ severity: 'blocker', issue: 'broken', file: 'a.ts', line: 3 }, { severity: 'weird', issue: 'meh' }, { issue: '' }, 'x'],
    });
    expect(report.summary).toBe('ok');
    expect(report.findings).toHaveLength(2);
    expect(countFindings(report.findings)).toEqual({ blocker: 1, major: 0, minor: 1 });
  });

  it('tells validation what to do with findings', () => {
    expect(formatReviewForValidation({ findings: [], summary: 'fine' })).toContain('found no issues');
    const text = formatReviewForValidation({ findings: [{ severity: 'major', issue: 'bug', file: 'a.ts', line: 2, fix: 'fix it' }], summary: 's' });
    expect(text).toContain('MAJOR [a.ts:2]: bug Suggested fix: fix it');
    expect(text).toContain('fix the ones that are real');
  });

  it('preserves human findings while asking validation to verify applicability without inventing resolution', () => {
    const report = {
      findings: [{ severity: 'major' as const, issue: 'Gate F participant sessions are pending', requiresHuman: true }],
      summary: 'Report correction is otherwise complete',
    };
    const text = formatReviewForValidation(report);
    expect(text).toContain('Gate F participant sessions are pending');
    expect(text).toContain('verify task applicability');
    expect(text).toContain('applicable human requirements remain pending until actual evidence or a scoped owner decision exists');
    expect(text).toContain('outside this task\'s scope, explaining why in the summary');
    expect(text).toContain('do not label it fixed or infer approval');
    expect(report.findings[0].requiresHuman).toBe(true);
  });
});
