import { describe, expect, it } from 'vitest';
import type { ClaudeRunInfo } from '../../types/claude-code';
import {
  buildWorkSummary,
  checksOutcome,
  findingsOutcome,
  hasWorkSummary,
  parseNumstat,
  reviewOutcome,
  topChangedFiles,
} from '../task-work-summary';

function run(overrides: Partial<ClaudeRunInfo> = {}): ClaudeRunInfo {
  return { version: 1, phases: [], subagents: [], totalCostUsd: 0, updatedAt: '2026-10-25T00:00:00Z', ...overrides };
}

describe('task-work-summary', () => {
  it('reads the review verdict', () => {
    expect(reviewOutcome(undefined)).toEqual({ kind: 'none' });
    expect(reviewOutcome(run({ reviewVerdict: { status: 'passed', rounds: 1, maxRounds: 3 } }))).toEqual({ kind: 'passed', rounds: 1, maxRounds: 3 });
    expect(reviewOutcome(run({ reviewVerdict: { status: 'failed', rounds: 3, maxRounds: 3 } })).kind).toBe('failed');
  });

  it('counts checks and names the failing ones', () => {
    expect(checksOutcome(run())).toBeNull();
    const r = run({
      validation: {
        status: 'partial',
        summary: 's',
        checks: [
          { name: 'typecheck', command: 'tsc', passed: true },
          { name: 'tests', command: 'vitest', passed: false },
        ],
        findings: [],
      },
    });
    expect(checksOutcome(r)).toEqual({ total: 2, passed: 1, failing: ['tests'] });
  });

  it('groups open findings by severity, most severe first', () => {
    const r = run({
      validation: {
        status: 'passed',
        summary: 's',
        checks: [],
        findings: [
          { severity: 'minor', description: 'a', fixed: false },
          { severity: 'major', description: 'b', fixed: true },
          { severity: 'critical', description: 'c', fixed: false },
          { severity: 'minor', description: 'd', fixed: false },
        ],
      },
    });
    const f = findingsOutcome(r);
    expect(f.open.map((x) => x.description)).toEqual(['c', 'a', 'd']);
    expect([f.critical, f.major, f.minor]).toEqual([1, 0, 2]);
  });

  it('sums effort and lists models per step without triage', () => {
    const r = run({
      totalCostUsd: 0.5,
      phases: [
        { name: 'triage', model: 'sonnet', startedAt: '2026-10-25T01:00:00Z', endedAt: '2026-10-25T01:01:00Z' },
        { name: 'plan', model: 'opus', startedAt: 'x', durationMs: 1000 },
        { name: 'implement', model: 'opus', startedAt: 'x', durationMs: 2000 },
        { name: 'implement', model: 'local', startedAt: 'x', durationMs: 3000 },
      ],
    });
    const e = buildWorkSummary(r).effort;
    expect(e.durationMs).toBe(66000);
    expect(e.costUsd).toBe(0.5);
    expect(e.models).toEqual([
      { model: 'opus', phases: ['plan', 'implement'] },
      { model: 'local', phases: ['implement'] },
    ]);
  });

  it('falls back to the validation summary and reports when there is nothing to show', () => {
    expect(buildWorkSummary(run({ summary: '  Did it  ' })).summary).toBe('Did it');
    const r = run({ validation: { status: 'passed', summary: 'Validated', checks: [], findings: [] } });
    expect(buildWorkSummary(r).summary).toBe('Validated');
    expect(buildWorkSummary(run()).summary).toBeNull();
    expect(hasWorkSummary(run())).toBe(false);
    expect(hasWorkSummary(r)).toBe(true);
  });

  it('parses numstat including binary files and renames', () => {
    const files = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tlogo.png\n1\t0\tsrc/{a => b}.ts\n\n');
    expect(files).toEqual([
      { path: 'src/a.ts', additions: 12, deletions: 3 },
      { path: 'logo.png', additions: 0, deletions: 0 },
      { path: 'src/{a => b}.ts', additions: 1, deletions: 0 },
    ]);
  });

  it('shows the biggest files and counts the rest', () => {
    const files = [1, 2, 3, 4].map((n) => ({ path: `f${n}`, additions: n, deletions: 0 }));
    const { shown, more } = topChangedFiles(files, 2);
    expect(shown.map((f) => f.path)).toEqual(['f4', 'f3']);
    expect(more).toBe(2);
  });
});
