import { describe, expect, it } from 'vitest';
import {
  REVIEW_SUMMARY_SYSTEM_PROMPT,
  buildReviewSummaryPrompt,
  cleanSummaryText,
  extractPlanGoal,
  normalizeReviewSummary,
  parseReviewSummaryReply,
} from '../review-summary';
import { reviewSummaryMode, shouldGenerateReviewSummary, changeStatsLine } from '../task-work-summary';
import type { ClaudeRunInfo } from '../../types/claude-code';

function run(overrides: Partial<ClaudeRunInfo> = {}): ClaudeRunInfo {
  return { version: 1, phases: [], subagents: [], totalCostUsd: 0, updatedAt: '2026-10-25T00:00:00Z', ...overrides };
}

describe('cleanSummaryText', () => {
  it('strips backticks, paths, file names, hashes and dashes', () => {
    const out = cleanSummaryText('`observation.ts` in src/core/rng.ts was fixed in commit 92bf9b7 — same stream');
    expect(out).not.toMatch(/`|src\/|\.ts|92bf9b7|—/);
    expect(out).toContain('same stream');
  });

  it('keeps ordinary slashes and words', () => {
    expect(cleanSummaryText('Works for input/output and 24/7 use')).toBe('Works for input/output and 24/7 use');
  });
});

describe('normalizeReviewSummary', () => {
  it('caps bullets, drops empties and duplicates', () => {
    const s = normalizeReviewSummary(
      {
        headline: 'The engine now exists.',
        whatChanged: ['a', 'b', 'b', '', 'c', 'd', 'e', 'f', 7],
        verified: 'Tests pass.',
        needsAttention: ['1', '2', '3', '4', '5'],
      },
      'now'
    );
    expect(s?.whatChanged).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s?.needsAttention).toHaveLength(4);
    expect(s?.generatedAt).toBe('now');
  });

  it('truncates long text and rejects empty results', () => {
    const s = normalizeReviewSummary({ headline: 'x '.repeat(400), whatChanged: ['ok'], verified: '', needsAttention: [] });
    expect(s!.headline.length).toBeLessThanOrEqual(245);
    expect(normalizeReviewSummary({ headline: '', whatChanged: ['ok'] })).toBeNull();
    expect(normalizeReviewSummary({ headline: 'h', whatChanged: [] })).toBeNull();
    expect(normalizeReviewSummary('nope')).toBeNull();
  });

  it('parses JSON out of a text reply', () => {
    const s = parseReviewSummaryReply(undefined, 'Here:\n```json\n{"headline":"H","whatChanged":["a"],"verified":"v","needsAttention":[]}\n```');
    expect(s?.headline).toBe('H');
    expect(parseReviewSummaryReply(undefined, 'no json')).toBeNull();
  });
});

describe('buildReviewSummaryPrompt', () => {
  it('trims long input and contains no code', () => {
    const prompt = buildReviewSummaryPrompt({
      title: 'Foundation "core"',
      request: 'r'.repeat(10_000),
      plan: '# Plan\n## Goal\nBuild the core.\n## Steps\n1. do things',
      agentSummary: 'a'.repeat(10_000),
      validation: {
        status: 'passed',
        summary: 'ok',
        checks: [{ name: 'tests', passed: true }],
        findings: [
          { severity: 'major', description: 'open one', fixed: false },
          { severity: 'minor', description: 'done', fixed: true },
        ],
      },
      verdict: { status: 'passed', rounds: 1, maxRounds: 3 },
      changes: { files: [{ path: 'src/a.ts', additions: 5, deletions: 1 }], additions: 5, deletions: 1, commitCount: 2 },
    });
    expect(prompt.length).toBeLessThan(9_000);
    expect(prompt).toContain('Build the core.');
    expect(prompt).not.toContain('do things');
    expect(prompt).toContain('1 open, 1 fixed');
    expect(prompt).toContain('src/a.ts +5 -1');
    expect(prompt).toContain('title="Foundation \'core\'"');
  });

  it('only sends a short plan goal', () => {
    expect(extractPlanGoal(`## Goal\n${'x'.repeat(2000)}\n## Next`)).toBeUndefined();
    expect(extractPlanGoal('no headings')).toBeUndefined();
  });
});

describe('panel display decisions', () => {
  const summary = { headline: 'h', whatChanged: ['a'], verified: 'v', needsAttention: [], generatedAt: 'x' };

  it('picks the mode', () => {
    expect(reviewSummaryMode(run({ reviewSummary: summary }), 'pending')).toBe('summary');
    expect(reviewSummaryMode(run(), 'pending')).toBe('pending');
    expect(reviewSummaryMode(run(), 'failed')).toBe('fallback');
    expect(reviewSummaryMode(undefined, 'idle')).toBe('fallback');
  });

  it('asks for a summary only in Human Review without one', () => {
    expect(shouldGenerateReviewSummary({ status: 'human_review', claudeRun: run({ summary: 's' }) })).toBe(true);
    expect(shouldGenerateReviewSummary({ status: 'human_review', claudeRun: run({ summary: 's', reviewSummary: summary }) })).toBe(false);
    expect(shouldGenerateReviewSummary({ status: 'in_progress', claudeRun: run({ summary: 's' }) })).toBe(false);
    expect(shouldGenerateReviewSummary({ status: 'human_review', claudeRun: run() })).toBe(false);
    expect(shouldGenerateReviewSummary({ status: 'human_review' })).toBe(false);
  });

  it('counts the change stats', () => {
    expect(changeStatsLine({ files: [1, 2], additions: 3, deletions: 4 })).toEqual({ files: 2, additions: 3, deletions: 4, commits: 0 });
  });
});

describe('workflow status in needs-attention', () => {
  it('drops bullets about merging or branches, which the app shows itself (seen live on an auto-merged task)', () => {
    const summary = normalizeReviewSummary({
      headline: 'The game now has its foundation.',
      whatChanged: ['Scenarios are defined as validated data.'],
      verified: 'All tests pass.',
      needsAttention: [
        'The work sits on a separate branch and was intentionally not merged.',
        'One assumption: a two-week delay between uses is a fixture default.',
      ],
    });
    expect(summary?.needsAttention).toEqual(['One assumption: a two-week delay between uses is a fixture default.']);
  });

  it('tells the model not to report workflow state', () => {
    expect(REVIEW_SUMMARY_SYSTEM_PROMPT).toContain('Never describe where the work stands in the workflow');
  });
});

it('describes owner-overridden human findings separately instead of reopening the approval loop', () => {
  const prompt = buildReviewSummaryPrompt({ title: 'Acceptance', request: 'Complete the task', validation: { status: 'failed', summary: 'Human sign-off missing', checks: [{ name: 'tests', passed: true }], findings: [{ severity: 'major', description: 'Research approval is missing', fixed: false, requiresHuman: true }] }, verdict: { status: 'passed', rounds: 1, maxRounds: 3, humanApprovalOverride: { scope: 'task-human-approval', approver: 'Ian', reason: 'Approve all current Research views', at: '2026-10-27T20:00:00Z', revision: 1 } } });
  expect(prompt).toContain('0 open, 0 fixed, 1 overridden by the owner (not fixed)');
  expect(prompt).not.toContain('Open major finding: Research approval is missing');
  expect(prompt).toContain('do not list overridden approval gates as still blocking');
});
