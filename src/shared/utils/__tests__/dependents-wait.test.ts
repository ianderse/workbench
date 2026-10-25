import { describe, expect, it } from 'vitest';
import type { Task, TaskMetadata } from '../../types';
import { addDependencyToDependents, openFollowUpIdsOf } from '../dependents-wait';

function task(id: string, status: Task['status'], metadata: TaskMetadata = {}, extra: Partial<Task> = {}): Task {
  return { id, specId: `${id}-spec`, projectId: 'p', title: id, description: '', status, subtasks: [], logs: [], metadata, createdAt: new Date(), updatedAt: new Date(), ...extra };
}
const dep = (...ids: string[]): TaskMetadata => ({ dependsOnTaskIds: ids });

describe('addDependencyToDependents', () => {
  it('adds the new ticket to Planning and Queue dependents', () => {
    const tasks = [task('s', 'human_review'), task('n', 'queue', dep('s')), task('q', 'queue', dep('s')), task('b', 'backlog', dep('s'))];
    const result = addDependencyToDependents(tasks, ['s'], ['n']);
    expect(result).toEqual({ q: ['s', 'n'], b: ['s', 'n'] });
  });

  it('matches a dependency written as spec id', () => {
    const tasks = [task('s', 'done'), task('q', 'queue', dep('s-spec'))];
    expect(addDependencyToDependents(tasks, ['s'], ['n'])).toEqual({ q: ['s-spec', 'n'] });
  });

  it('includes a queued ticket that ran before (stopped and re-queued)', () => {
    const tasks = [task('s', 'done'), task('ran', 'queue', dep('s'), { claudeRun: {} as Task['claudeRun'] })];
    expect(addDependencyToDependents(tasks, ['s'], ['n'])).toEqual({ ran: ['s', 'n'] });
  });

  it('skips in-progress, review, done and archived dependents', () => {
    const tasks = [
      task('s', 'done'),
      task('prog', 'in_progress', dep('s')),
      task('rev', 'human_review', dep('s')),
      task('fin', 'done', dep('s')),
      task('arch', 'queue', { ...dep('s'), archivedAt: '2026-01-01' }),
      task('unrelated', 'queue', dep('x')),
    ];
    expect(addDependencyToDependents(tasks, ['s'], ['n'])).toEqual({});
  });

  it('skips needs-decision tickets and siblings from the same source', () => {
    const tasks = [
      task('s', 'done'),
      task('dec', 'backlog', { ...dep('s'), followUpFrom: { taskId: 's', item: 'x', needsDecision: true } }),
      task('sib', 'queue', { ...dep('s'), followUpFrom: { taskId: 's', item: 'y' } }),
    ];
    expect(addDependencyToDependents(tasks, ['s'], ['n'])).toEqual({});
  });

  it('never adds a ticket to itself, to its ancestors or twice', () => {
    const tasks = [task('s', 'done'), task('anc', 'queue', dep('s')), task('n', 'queue', dep('anc')), task('q', 'queue', dep('s', 'n'))];
    expect(addDependencyToDependents(tasks, ['s'], ['n'])).toEqual({});
    const viaExtra = [task('s', 'done'), task('anc', 'queue', dep('s'))];
    expect(addDependencyToDependents(viaExtra, ['s'], ['n'], { n: ['anc'] })).toEqual({});
  });

  it('handles several sources and new tickets', () => {
    const tasks = [task('s', 'done'), task('d', 'done'), task('q', 'queue', dep('d'))];
    expect(addDependencyToDependents(tasks, ['s', 'd'], ['n1', 'n2'])).toEqual({ q: ['d', 'n1', 'n2'] });
  });
});

describe('openFollowUpIdsOf', () => {
  it('collects open follow-ups transitively, without finished or pending decisions', () => {
    const tasks = [
      task('s', 'done'),
      task('f1', 'queue', { followUpFrom: { taskId: 's', item: 'a' } }),
      task('dec', 'done', { followUpFrom: { taskId: 's', item: 'b', needsDecision: true } }),
      task('f2', 'queue', { followUpFrom: { taskId: 'dec', item: 'decision' } }),
      task('pend', 'backlog', { followUpFrom: { taskId: 's', item: 'c', needsDecision: true } }),
      task('old', 'done', { followUpFrom: { taskId: 's', item: 'd' } }),
    ];
    expect(openFollowUpIdsOf(tasks, ['s']).sort()).toEqual(['f1', 'f2']);
  });
});
