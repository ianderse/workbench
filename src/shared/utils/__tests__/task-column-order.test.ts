import { describe, it, expect } from 'vitest';
import { sortColumnTasks } from '../task-column-order';

const task = (id: string, createdAt: number) => ({ id, createdAt: new Date(createdAt) });

describe('sortColumnTasks', () => {
  it('orders newest first when the column has no saved order', () => {
    expect(sortColumnTasks([task('a', 1), task('b', 3), task('c', 2)]).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('puts unplaced tasks on top (newest first), then the saved order, ignoring stale ids', () => {
    const tasks = [task('a', 1), task('b', 2), task('c', 3), task('d', 4)];
    expect(sortColumnTasks(tasks, ['gone', 'b', 'a']).map((t) => t.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});
