/**
 * Queue grooming rules: validating the model's answer, context note blocks, and what archiving a
 * ticket does to the others' dependencies
 */
import { describe, it, expect } from 'vitest';
import {
  appendNoteBlock,
  buildNoteBlock,
  normalizeGroomingResult,
  planArchive,
  removeNoteBlock,
  taskNumber,
  type GroomTask,
} from '../queue-grooming';

const t = (id: string, status: string, dependsOn: string[] = [], extra: Partial<GroomTask> = {}): GroomTask => ({
  id,
  title: `Title ${id}`,
  status,
  dependsOn,
  ...extra,
});

const tasks: GroomTask[] = [
  t('001-prng', 'done'),
  t('002-map', 'queue', ['001-prng']),
  t('003-mobs', 'backlog', ['002-map']),
  t('004-loot', 'queue'),
  t('005-ui', 'in_progress'),
  t('006-review', 'human_review'),
  t('007-old', 'backlog', [], { archived: true }),
];

describe('normalizeGroomingResult', () => {
  it('drops updates for unknown ids and for tasks that are not in Planning or the Queue', () => {
    const result = normalizeGroomingResult(
      {
        updates: [
          { taskId: 'nope', kind: 'note', note: 'x', reason: 'r' },
          { taskId: '005-ui', kind: 'obsolete', reason: 'running' },
          { taskId: '006-review', kind: 'note', note: 'x', reason: 'r' },
          { taskId: '001-prng', kind: 'obsolete', reason: 'done already' },
          { taskId: '007-old', kind: 'note', note: 'x', reason: 'r' },
          { taskId: '002-map', kind: 'note', note: 'Use createRng(seed) from src/core/prng.ts', reason: 'merged' },
        ],
        newTasks: [],
      },
      tasks,
      '001-prng'
    );
    expect(result.updates).toEqual([
      { taskId: '002-map', kind: 'note', note: 'Use createRng(seed) from src/core/prng.ts', reason: 'merged' },
    ]);
  });

  it('never updates the merged task itself and keeps one update per ticket', () => {
    const result = normalizeGroomingResult(
      {
        updates: [
          { taskId: '004-loot', kind: 'note', note: 'first', reason: '' },
          { taskId: '004-loot', kind: 'obsolete', reason: 'second' },
        ],
        newTasks: [],
      },
      [...tasks, t('008-merged', 'queue')],
      '008-merged'
    );
    expect(result.updates.map((u) => u.kind)).toEqual(['note']);
    expect(normalizeGroomingResult({ updates: [{ taskId: '008-merged', kind: 'note', note: 'x', reason: '' }], newTasks: [] }, [...tasks, t('008-merged', 'queue')], '008-merged').updates).toEqual([]);
  });

  it('drops malformed updates (empty note, obsolete without a reason, bad duplicate targets)', () => {
    const result = normalizeGroomingResult(
      {
        updates: [
          { taskId: '002-map', kind: 'note', note: '   ', reason: 'r' },
          { taskId: '003-mobs', kind: 'obsolete', reason: '' },
          { taskId: '004-loot', kind: 'duplicate', duplicateOf: '004-loot', reason: 'self' },
          { taskId: '004-loot', kind: 'duplicate', duplicateOf: 'ghost', reason: 'unknown' },
          { taskId: '004-loot', kind: 'duplicate', duplicateOf: '007-old', reason: 'archived target' },
          { taskId: '004-loot', kind: 'banana', reason: 'x' },
        ],
        newTasks: [],
      },
      tasks,
      '001-prng'
    );
    expect(result.updates).toEqual([]);
  });

  it('does not accept a duplicate whose kept ticket waits for the archived one, or is removed itself', () => {
    const result = normalizeGroomingResult(
      {
        updates: [
          // 003 waits for 002, so moving 002's dependents onto 003 would make it wait for itself
          { taskId: '002-map', kind: 'duplicate', duplicateOf: '003-mobs', reason: 'same' },
          // 004 is removed by the next update, so it cannot be the kept ticket
          { taskId: '003-mobs', kind: 'duplicate', duplicateOf: '004-loot', reason: 'same' },
          { taskId: '004-loot', kind: 'obsolete', reason: 'done elsewhere' },
        ],
        newTasks: [],
      },
      tasks,
      '001-prng'
    );
    expect(result.updates.map((u) => `${u.kind}:${u.taskId}`)).toEqual(['obsolete:004-loot']);
  });

  it('keeps new tasks that wait only for existing tasks that stay, without duplicates or cycles', () => {
    const result = normalizeGroomingResult(
      {
        updates: [{ taskId: '004-loot', kind: 'duplicate', duplicateOf: '002-map', reason: 'same' }],
        newTasks: [
          { title: 'Add retries.', description: 'Do it', dependsOn: ['002-map', 'ghost', '002-map', '004-loot', '007-old', '001-prng'], reason: 'follow-up' },
          { title: 'Title 003-mobs', description: 'copy of an existing ticket', dependsOn: [], reason: '' },
          { title: 'add retries', description: 'copy of the card above', dependsOn: [], reason: '' },
          { title: '', description: 'no title', dependsOn: [], reason: '' },
        ],
      },
      tasks,
      '001-prng'
    );
    expect(result.newTasks).toHaveLength(1);
    // 004-loot is archived as a duplicate of 002-map, so the new card waits for 002-map once
    expect(result.newTasks[0]).toMatchObject({ title: 'Add retries', dependsOn: ['002-map', '001-prng'] });
  });

  it('tolerates garbage', () => {
    expect(normalizeGroomingResult(null, tasks, 'x')).toEqual({ updates: [], newTasks: [] });
    expect(normalizeGroomingResult({ updates: 'no', newTasks: 5 }, tasks, 'x')).toEqual({ updates: [], newTasks: [] });
  });
});

describe('context note blocks', () => {
  it('append under a heading naming the merged task and remove again exactly', () => {
    const block = buildNoteBlock('001-prng', 'Use createRng(seed)');
    expect(block).toContain('**Update after #001 merged**');
    const updated = appendNoteBlock('Build the map generator.\n', block);
    expect(updated).toBe(`Build the map generator.${block}`);
    expect(removeNoteBlock(updated, block)).toBe('Build the map generator.');
  });

  it('removes a note from the middle of a description with several notes', () => {
    const a = buildNoteBlock('001-a', 'Note A');
    const b = buildNoteBlock('002-b', 'Note B');
    const both = appendNoteBlock(appendNoteBlock('Body', a), b);
    expect(removeNoteBlock(both, a)).toBe(`Body${b}`);
  });

  it('leaves the description alone when the user already edited the note away', () => {
    expect(removeNoteBlock('Body only', buildNoteBlock('001-a', 'Note A'))).toBe('Body only');
  });

  it('numbers tasks by their id prefix', () => {
    expect(taskNumber('012-thing')).toBe('012');
    expect(taskNumber('custom')).toBe('custom');
  });
});

describe('planArchive', () => {
  it('obsolete: dependents stop waiting for the archived ticket', () => {
    const plan = planArchive(tasks, '002-map');
    expect(plan.archive).toEqual(['002-map']);
    expect(plan.setDependsOn).toEqual({ '003-mobs': [] });
  });

  it('duplicate: dependents move onto the kept ticket', () => {
    const plan = planArchive(tasks, '004-loot', '002-map');
    expect(plan.setDependsOn).toEqual({});
    const graph = [...tasks, t('009-after-loot', 'queue', ['004-loot', '001-prng'])];
    expect(planArchive(graph, '004-loot', '002-map').setDependsOn).toEqual({ '009-after-loot': ['001-prng', '002-map'] });
  });

  it('duplicate: does not make the kept ticket wait for itself or form a cycle', () => {
    const graph = [t('a', 'queue'), t('b', 'queue', ['a']), t('c', 'queue', ['b'])];
    // c waits for b; b is archived as a duplicate of c: c must not end up waiting for c
    expect(planArchive(graph, 'b', 'c').setDependsOn).toEqual({ c: [] });
    // a is the duplicate of c: b waits for a, and c (transitively) waits for b, so b may not wait for c
    expect(planArchive(graph, 'a', 'c').setDependsOn).toEqual({ b: [] });
  });
});
