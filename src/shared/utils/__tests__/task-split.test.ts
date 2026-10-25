import { describe, it, expect } from 'vitest';
import {
  buildPlanSchema,
  buildSplitDescription,
  buildSplitNote,
  canTaskSplit,
  deferredToSplit,
  normalizeSplit,
  parseDeferredSection,
  pieceDependsOn,
  planSplitRewire,
  resolveSelfSplit,
} from '../task-split';
import { canResumeTask } from '../task-resume';
import type { Task } from '../../types/task';

const piece = (n: number) => ({ title: `Piece ${n}`, description: `Do piece ${n} fully`, reason: 'Separate area' });

describe('resolveSelfSplit and canTaskSplit', () => {
  it('derives the default from autonomous mode and honours an explicit choice', () => {
    expect(resolveSelfSplit(undefined)).toBe('propose');
    expect(resolveSelfSplit({ autonomous: true })).toBe('auto');
    expect(resolveSelfSplit({ autonomous: true, selfSplit: 'off' })).toBe('off');
    expect(resolveSelfSplit({ selfSplit: 'auto' })).toBe('auto');
    expect(resolveSelfSplit({ selfSplit: 'bogus' as never })).toBe('propose');
  });

  it('allows one split, and none for a split-created ticket or when off', () => {
    expect(canTaskSplit('propose', {})).toBe(true);
    expect(canTaskSplit('off', {})).toBe(false);
    expect(canTaskSplit('auto', { splitFrom: '001-big' })).toBe(false);
    expect(canTaskSplit('auto', { splitInto: { taskIds: [] } })).toBe(false);
  });
});

describe('buildPlanSchema', () => {
  it('has the split option only when allowed', () => {
    expect(Object.keys((buildPlanSchema(true) as { properties: object }).properties)).toEqual(['plan', 'split']);
    expect(Object.keys((buildPlanSchema(false) as { properties: object }).properties)).toEqual(['plan']);
    expect((buildPlanSchema(true) as { required: string[] }).required).toEqual(['plan']);
  });
});

describe('normalizeSplit', () => {
  const raw = (n: number) => ({ reason: 'Too big', keepScope: 'The core', newTickets: Array.from({ length: n }, (_, i) => piece(i + 1)) });

  it('accepts one to four new tickets and cuts the rest', () => {
    expect(normalizeSplit(raw(1), true)?.pieces).toHaveLength(1);
    expect(normalizeSplit(raw(4), true)?.pieces).toHaveLength(4);
    expect(normalizeSplit(raw(7), true)?.pieces.map((p) => p.title)).toEqual(['Piece 1', 'Piece 2', 'Piece 3', 'Piece 4']);
  });

  it('ignores the split at depth 1 (not allowed), or when empty or invalid', () => {
    expect(normalizeSplit(raw(2), false)).toBeNull();
    expect(normalizeSplit(undefined, true)).toBeNull();
    expect(normalizeSplit('split', true)).toBeNull();
    expect(normalizeSplit({ ...raw(2), newTickets: [] }, true)).toBeNull();
    expect(normalizeSplit({ ...raw(2), keepScope: '  ' }, true)).toBeNull();
    expect(normalizeSplit({ ...raw(2), newTickets: 'x' }, true)).toBeNull();
    expect(normalizeSplit({ reason: 'x', keepScope: 'k', newTickets: [{ title: '', description: 'd' }, { title: 't' }, null] }, true)).toBeNull();
  });

  it('drops invalid and repeated pieces and trailing periods in titles', () => {
    const split = normalizeSplit({
      reason: 'r',
      keepScope: 'k',
      newTickets: [
        { title: 'Add divide.', description: 'd1' },
        { title: 'add  divide', description: 'd2' },
        { title: 'No description', description: '' },
        { title: 'Add modulo', description: 'd3', reason: 'because' },
      ],
    }, true);
    expect(split?.pieces.map((p) => p.title)).toEqual(['Add divide', 'Add modulo']);
  });
});

describe('parseDeferredSection', () => {
  it('treats "none" with an explanation as nothing deferred (made an empty follow-up ticket live)', () => {
    for (const none of [
      'None \u2014 everything in the ticket is done and committed.',
      'None, everything is done.',
      'Nothing left: all items shipped',
      'N/A (all done)',
      'All done.',
      'No remaining work.',
    ]) {
      expect(parseDeferredSection(`Done.\n\n## Deferred\n- ${none}\n`).items).toEqual([]);
    }
    // A real item that happens to start with "None" stays
    expect(parseDeferredSection('Done.\n\n## Deferred\n- None of the save tests cover mid-draft cancellation\n').items)
      .toEqual(['None of the save tests cover mid-draft cancellation']);
  });

  it('reads a Deferred list and returns the answer without it', () => {
    const answer = 'Added subtract.\n\n## Deferred\n- Add divide\n- Add modulo\n  with tests\n';
    const parsed = parseDeferredSection(answer);
    expect(parsed.items).toEqual(['Add divide', 'Add modulo with tests']);
    expect(parsed.rest).toBe('Added subtract.');
  });

  it('is tolerant of how local models write the heading and the bullets', () => {
    expect(parseDeferredSection('Done.\n**Deferred**\n* a\n* b').items).toEqual(['a', 'b']);
    expect(parseDeferredSection('Done.\n### Deferred work:\n1. first\n2) second').items).toEqual(['first', 'second']);
    expect(parseDeferredSection('Done.\nDeferred:\n- x').items).toEqual(['x']);
  });

  it('stops at the next heading or a closing paragraph and keeps them in the rest', () => {
    const parsed = parseDeferredSection('Summary\n\n## Deferred\n- one\n\n## Notes\nSomething else');
    expect(parsed.items).toEqual(['one']);
    expect(parsed.rest).toContain('## Notes');
    expect(parseDeferredSection('## Deferred\n- one\nThat is all.').rest).toBe('That is all.');
  });

  it('finds nothing without a section or with a "none" answer', () => {
    expect(parseDeferredSection('All done, nothing was deferred.').items).toEqual([]);
    expect(parseDeferredSection('Done\n## Deferred\n- None').items).toEqual([]);
    expect(parseDeferredSection('Done\n## Deferred\nNothing.').items).toEqual([]);
    expect(parseDeferredSection('').items).toEqual([]);
  });
});

describe('deferredToSplit', () => {
  it('turns the items into one self-contained ticket and keeps the done summary', () => {
    const split = deferredToSplit({ id: '007-big', title: 'Big ticket' }, ['Add divide', 'Add modulo'], 'Added subtract')!;
    expect(split.pieces).toHaveLength(1);
    expect(split.pieces[0].title).toBe('Remaining from Big ticket');
    expect(split.pieces[0].description).toContain('#007');
    expect(split.pieces[0].description).toContain('- Add divide\n- Add modulo');
    expect(split.keepScope).toContain('Added subtract');
    expect(deferredToSplit({ id: 'x', title: 't' }, [], 'summary')).toBeNull();
  });
});

describe('split text and rewiring', () => {
  it('keeps the original scope in a collapsed block', () => {
    const description = buildSplitDescription('Only subtract', 'Add subtract and divide');
    expect(description.startsWith('Only subtract')).toBe(true);
    expect(description).toContain('<details>');
    expect(description).toContain('Original scope');
    expect(description).toContain('Add subtract and divide');
    expect(buildSplitDescription('Only subtract', '')).toBe('Only subtract');
  });

  it('writes the note with the real date and ids', () => {
    const note = buildSplitNote(new Date(2026, 9, 24, 12), [{ title: 'X' }, { title: 'Y' }], ['008-x', '009-y']);
    expect(note).toBe('Split on 2026-10-24: moved "X" and "Y" to #008 and #009');
  });

  it('chains the pieces: the first waits for the task, each next one for the piece before', () => {
    expect(pieceDependsOn('007', [], 0)).toEqual(['007']);
    expect(pieceDependsOn('007', ['008'], 1)).toEqual(['008']);
    expect(pieceDependsOn('007', ['008', '009'], 2)).toEqual(['009']);
  });

  it('rewires only queued and planning dependents onto the last piece', () => {
    const task = (id: string, status: string, dependsOn: string[], archived = false) => ({ id, title: id, status, dependsOn, archived });
    const rewired = planSplitRewire(
      [
        task('007', 'in_progress', []),
        task('010', 'queue', ['007', '003']),
        task('011', 'backlog', ['007']),
        task('012', 'in_progress', ['007']),
        task('013', 'done', ['007']),
        task('014', 'queue', ['003']),
        task('015', 'queue', ['007'], true),
      ],
      '007',
      '009'
    );
    expect(rewired).toEqual({ '010': ['009', '003'], '011': ['009'] });
  });
});

describe('canResumeTask for a proposed split', () => {
  it('can be resumed from Human Review split_proposed while the run is unfinished', () => {
    const task = { status: 'human_review', reviewReason: 'split_proposed', claudeRun: { phases: [{ name: 'plan', startedAt: 'a', endedAt: 'b' }] } } as unknown as Task;
    expect(canResumeTask(task)).toBe(true);
  });
});
