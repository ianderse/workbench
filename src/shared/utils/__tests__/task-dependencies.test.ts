import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import { resolveTaskDependencies, unmetDependencyLabel } from '../task-dependencies';

function makeTask(id: string, status: Task['status'], extra: Partial<Task> = {}): Task {
  return { id, specId: id, title: `Title ${id}`, status, metadata: {}, ...extra } as Task;
}

const dependent = makeTask('010-main', 'queue', {
  metadata: { dependsOnTaskIds: ['003-a', '005-b', '006-c', '007-d', '404-gone', '010-main'] }
});
const tasks = [
  dependent,
  makeTask('003-a', 'done'),
  makeTask('005-b', 'in_progress'),
  makeTask('006-c', 'human_review', { metadata: { autoMerge: { branch: 'main', sha: 'x', at: 'now' } } as Task['metadata'] }),
  makeTask('007-d', 'backlog', { metadata: { archivedAt: 'now' } as Task['metadata'] })
];

describe('resolveTaskDependencies', () => {
  it('lists every dependency with its state', () => {
    expect(resolveTaskDependencies(tasks, dependent).map((d) => [d.number, d.state])).toEqual([
      ['003', 'done'],
      ['005', 'waiting'],
      ['006', 'waiting'],
      ['007', 'archived'],
      ['404', 'missing']
    ]);
  });

  it('counts an auto-merged dependency as merged in autonomous mode', () => {
    expect(resolveTaskDependencies(tasks, dependent, true).find((d) => d.number === '006')?.state).toBe('merged');
  });

  it('matches spec ids', () => {
    const t = makeTask('020-x', 'queue', { metadata: { dependsOnTaskIds: ['001-spec'] } });
    const dep = makeTask('uuid-1', 'done', { specId: '001-spec' });
    expect(resolveTaskDependencies([t, dep], t)[0]).toMatchObject({ number: 'uuid-1', state: 'done' });
  });
});

describe('unmetDependencyLabel', () => {
  it('names only the unmet dependencies, number first', () => {
    expect(unmetDependencyLabel(tasks, dependent)).toBe('#005 Title 005-b, #006 Title 006-c');
    expect(unmetDependencyLabel(tasks, dependent, true)).toBe('#005 Title 005-b');
  });

  it('is empty without dependencies', () => {
    expect(unmetDependencyLabel(tasks, tasks[1])).toBe('');
  });
});
