/**
 * "Since this ticket was written": what merged after a ticket was created, ordered with the
 * ticket's own dependencies first and capped in size
 */
import { describe, it, expect, vi } from 'vitest';
import type { Task } from '../../shared/types';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  buildSinceWrittenPrompt,
  collectFollowUps,
  collectMergedSince,
  extractSummaryFollowUps,
  mergedFromChangelog,
  transitiveDependencies,
  type MergedTaskBrief,
} from '../task-briefing';
import type { TaskChangelogEntry } from '../task-changelog';

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T10:00:00.000Z`;

function brief(id: string, mergedDay: number, extra: Partial<MergedTaskBrief> = {}): MergedTaskBrief {
  return { id, title: `Title ${id}`, mergedAt: day(mergedDay), summary: `Summary of ${id}`, files: [`src/${id}.ts`], followUps: [], ...extra };
}

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    specId: id,
    projectId: 'p',
    title: `Title ${id}`,
    description: '',
    status: 'done',
    subtasks: [],
    logs: [],
    createdAt: new Date(day(1)),
    updatedAt: new Date(day(2)),
    ...extra,
  } as Task;
}

describe('buildSinceWrittenPrompt', () => {
  it('returns nothing when no task merged since', () => {
    expect(buildSinceWrittenPrompt([], new Set())).toBeUndefined();
  });

  it("lists the ticket's dependencies first (oldest merge first), then the others newest first", () => {
    const prompt = buildSinceWrittenPrompt(
      [brief('004-d', 9), brief('002-b', 5), brief('001-a', 3), brief('003-c', 7), brief('005-e', 4)],
      new Set(['003-c', '001-a'])
    )!;
    const order = ['001-a', '003-c', '004-d', '002-b', '005-e'].map((id) => prompt.indexOf(`\`${id}\``));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain('(this ticket depends on it)');
    expect(prompt).toContain('Tasks this ticket depends on are listed first.');
  });

  it('includes summary, files and open follow-ups', () => {
    const prompt = buildSinceWrittenPrompt([brief('001-a', 3, { followUps: ['minor: rename createRng (src/core/prng.ts:12)'] })], new Set())!;
    expect(prompt).toContain('Summary: Summary of 001-a');
    expect(prompt).toContain('`src/001-a.ts`');
    expect(prompt).toContain('Open follow-ups:');
    expect(prompt).toContain('rename createRng');
  });

  it('stays under the size cap, keeping dependencies and dropping the oldest unrelated tasks first', () => {
    const long = 'x'.repeat(5000);
    const many = Array.from({ length: 30 }, (_, i) => brief(`${String(i + 1).padStart(3, '0')}-t`, (i % 27) + 1, { summary: long }));
    const deps = new Set(['001-t']);
    const prompt = buildSinceWrittenPrompt(many, deps, 6000)!;
    expect(prompt.length).toBeLessThanOrEqual(6000);
    expect(prompt).toContain('`001-t`');
    expect(prompt).toMatch(/\d+ more merged tasks? left out/);
    // The newest unrelated task is kept before older ones
    const newest = many.filter((m) => m.id !== '001-t').sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))[0];
    expect(prompt).toContain(`\`${newest.id}\``);
  });

  it('trims long summaries more for unrelated tasks than for dependencies', () => {
    const long = 'word '.repeat(1000);
    const prompt = buildSinceWrittenPrompt([brief('001-a', 3, { summary: long }), brief('002-b', 4, { summary: long })], new Set(['001-a']))!;
    const [first, second] = prompt.split('- `002-b`');
    expect(first.length).toBeGreaterThan(second.length);
  });
});

describe('transitiveDependencies', () => {
  it('follows dependencies through other tasks and survives cycles', () => {
    const tasks = [
      task('c', { metadata: { dependsOnTaskIds: ['b'] } }),
      task('b', { metadata: { dependsOnTaskIds: ['a'] } }),
      task('a', { metadata: { dependsOnTaskIds: ['c'] } }),
      task('z'),
    ];
    expect([...transitiveDependencies('c', tasks)].sort()).toEqual(['a', 'b']);
    expect([...transitiveDependencies('z', tasks)]).toEqual([]);
  });
});

describe('follow-ups', () => {
  it('reads the list under a Follow-ups heading in a summary', () => {
    const summary = 'Did the thing.\n\n## Follow-ups\n- Add retries to the loader\n- Document createRng\n\nVerified with tests.';
    expect(extractSummaryFollowUps(summary)).toEqual(['Add retries to the loader', 'Document createRng']);
  });

  it('reads an inline label', () => {
    expect(extractSummaryFollowUps('Done.\n**Follow-ups:** wire up the CLI flag')).toEqual(['wire up the CLI flag']);
  });

  it('collects unfixed findings of every severity, open review findings and summary follow-ups without repeats', () => {
    const run = {
      summary: 'Ok\nFollow-ups:\n- tidy imports',
      validation: {
        status: 'passed',
        summary: '',
        checks: [],
        findings: [
          { severity: 'minor', description: 'tidy imports', fixed: false, file: 'a.ts', line: 3 },
          { severity: 'minor', description: 'already fixed', fixed: true },
          { severity: 'major', description: 'cache never expires', fixed: false },
        ],
      },
    } as unknown as Task['claudeRun'];
    const items = collectFollowUps(run);
    expect(items).toContain('minor: tidy imports (a.ts:3)');
    expect(items).toContain('major: cache never expires');
    expect(items.some((i) => i.includes('already fixed'))).toBe(false);
    expect(items).toHaveLength(3);
  });
});

describe('mergedFromChangelog and collectMergedSince', () => {
  const entries: TaskChangelogEntry[] = [
    { at: day(2), task: '001-a', event: 'state', status: 'in_progress', files: ['src/a.ts'] },
    { at: day(3), task: '001-a', event: 'edit', files: ['src/a2.ts'] },
    { at: day(4), task: '001-a', event: 'state', status: 'done', files: [] },
    { at: day(1), task: '000-old', event: 'state', status: 'done', files: ['src/old.ts'] },
  ];

  it('takes the merge time from the done entry and the files from the entries before it', () => {
    const merged = mergedFromChangelog(entries);
    expect(merged.get('001-a')).toEqual({ mergedAt: day(4), files: ['src/a.ts', 'src/a2.ts'] });
  });

  it('only includes tasks merged after the ticket was created, never itself or archived tasks', () => {
    const tasks = [
      task('000-old'),
      task('001-a', { claudeRun: { summary: 'Made A' } as Task['claudeRun'] }),
      task('002-archived', { metadata: { archivedAt: day(5) } }),
      task('003-open', { status: 'queue' }),
      task('004-self', { createdAt: new Date(day(3)) }),
    ];
    const result = collectMergedSince({ id: '004-self', createdAt: day(3) }, tasks, mergedFromChangelog(entries));
    expect(result.map((r) => r.id)).toEqual(['001-a']);
    expect(result[0]).toMatchObject({ summary: 'Made A', files: ['src/a.ts', 'src/a2.ts'] });
  });
});
