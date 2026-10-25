import { describe, it, expect, vi } from 'vitest';

vi.mock('../claude-code/run-text', () => ({ runClaudeText: vi.fn(), READ_ONLY_TOOLS: ['Read'] }));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => ({}) }));

import { normalizeBreakdown } from '../task-breakdown';
import { sortByDependencies } from '../../shared/utils/task-breakdown-order';

const t = (key: string, dependsOn: string[] = [], title = `Task ${key}`) => ({ key, title, description: `Do ${key}`, dependsOn });

describe('normalizeBreakdown', () => {
  it('keeps valid tasks and dependencies', () => {
    const result = normalizeBreakdown({ tasks: [t('t1'), t('t2', ['t1'])] });
    expect(result.tasks.map((x) => [x.key, x.dependsOn])).toEqual([['t1', []], ['t2', ['t1']]]);
  });

  it('drops unknown, self and duplicate dependencies', () => {
    const result = normalizeBreakdown({ tasks: [t('t1', ['t1', 'nope']), t('t2', ['t1', 't1'])] });
    expect(result.tasks[0].dependsOn).toEqual([]);
    expect(result.tasks[1].dependsOn).toEqual(['t1']);
  });

  it('breaks cycles by dropping the edge that closes them', () => {
    const result = normalizeBreakdown({ tasks: [t('a', ['c']), t('b', ['a']), t('c', ['b'])] });
    const deps = Object.fromEntries(result.tasks.map((x) => [x.key, x.dependsOn]));
    expect(deps).toEqual({ a: ['c'], b: ['a'], c: [] });
  });

  it('orders tasks after their dependencies', () => {
    const result = normalizeBreakdown({ tasks: [t('t1', ['t2']), t('t2')] });
    expect(result.tasks.map((x) => x.key)).toEqual(['t2', 't1']);
  });

  it('repairs missing and repeated keys, trims titles, skips junk', () => {
    const result = normalizeBreakdown({
      tasks: [{ key: 'x', title: ' First. ', description: 'a', dependsOn: [] }, { key: 'x', title: 'Second', description: 'b' }, null, { title: '', description: '' }],
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].title).toBe('First');
    expect(new Set(result.tasks.map((x) => x.key)).size).toBe(2);
  });

  it('caps the number of tasks and requires at least one', () => {
    expect(normalizeBreakdown({ tasks: Array.from({ length: 20 }, (_, i) => t(`t${i}`)) }).tasks).toHaveLength(12);
    expect(() => normalizeBreakdown({ tasks: [] })).toThrow();
    expect(() => normalizeBreakdown(null)).toThrow();
  });

  it('sortByDependencies tolerates cycles', () => {
    expect(sortByDependencies([t('a', ['b']), t('b', ['a'])])).toHaveLength(2);
  });
});

describe('normalizeBreakdown with existing open tickets', () => {
  const open = [
    { id: '005-engine', title: 'Engine', status: 'queue' },
    { id: '006-save', title: 'Save', status: 'in_progress' },
  ];

  it('keeps open ticket ids next to new keys', () => {
    const result = normalizeBreakdown({ tasks: [t('t1', ['005-engine']), t('t2', ['t1', '006-save', '005-engine'])] }, open);
    const byKey = Object.fromEntries(result.tasks.map((x) => [x.key, x]));
    expect(byKey.t1.dependsOn).toEqual([]);
    expect(byKey.t1.dependsOnExisting).toEqual(['005-engine']);
    expect(byKey.t2.dependsOn).toEqual(['t1']);
    expect(byKey.t2.dependsOnExisting).toEqual(['006-save', '005-engine']);
  });

  it('drops ids of done, archived or unknown tickets (they are not in the open list)', () => {
    const result = normalizeBreakdown({ tasks: [t('t1', ['001-done', 'nope', '005-engine'])] }, open);
    expect(result.tasks[0].dependsOnExisting).toEqual(['005-engine']);
    expect(result.tasks[0].dependsOn).toEqual([]);
  });

  it('accepts a ticket number such as #005 when it names one open ticket', () => {
    const result = normalizeBreakdown({ tasks: [t('t1', ['#005', '6', '#009'])] }, open);
    expect(result.tasks[0].dependsOnExisting).toEqual(['005-engine', '006-save']);
  });

  it('still breaks cycles among new tasks', () => {
    const result = normalizeBreakdown({ tasks: [t('a', ['b', '005-engine']), t('b', ['a'])] }, open);
    const deps = Object.fromEntries(result.tasks.map((x) => [x.key, x.dependsOn]));
    expect(deps.a).toEqual(['b']);
    expect(deps.b).toEqual([]);
    expect(result.tasks.find((x) => x.key === 'a')!.dependsOnExisting).toEqual(['005-engine']);
  });

  it('has no existing dependencies without an open list', () => {
    const result = normalizeBreakdown({ tasks: [t('t1', ['005-engine'])] });
    expect(result.tasks[0].dependsOnExisting).toEqual([]);
  });
});
