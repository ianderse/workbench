import { describe, it, expect } from 'vitest';
import { reviewArrivedAt, sortColumnTasks, sortReviewColumn } from '../task-column-order';

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

describe('Human Review order', () => {
  const task = (id: string, fields: Record<string, unknown>) =>
    ({ id, createdAt: new Date('2026-10-24T18:00:00Z'), updatedAt: new Date('2026-10-25T09:00:00Z'), metadata: {}, ...fields }) as never;

  it('puts the task that has waited longest on top, by arrival in review rather than creation', () => {
    const sorted = sortReviewColumn([
      // Created first but reached review last
      task('a', { createdAt: new Date('2026-10-24T10:00:00Z'), claudeRun: { phases: [{ name: 'validate', startedAt: 'x', endedAt: '2026-10-25T06:00:00Z' }] } }),
      task('b', { metadata: { autoMerge: { sha: 's', branch: 'main', at: '2026-10-25T03:00:00Z' } } }),
      task('c', { claudeRun: { phases: [{ name: 'validate', startedAt: 'x', endedAt: '2026-10-25T05:00:00Z' }] } }),
    ]);
    expect(sorted.map((t: { id: string }) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('falls back to the last update when the run has no end', () => {
    expect(reviewArrivedAt(task('d', {}))).toBe(new Date('2026-10-25T09:00:00Z').getTime());
  });
});
