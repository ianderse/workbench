import { describe, it, expect } from 'vitest';
import { TASK_STATUS_COLUMNS, canMoveTask, getAllowedTaskMoves, getTaskColumn } from '../task';

describe('getTaskColumn', () => {
  it('shows pr_created tasks in Done and error tasks in Human Review', () => {
    expect(getTaskColumn('pr_created')).toBe('done');
    expect(getTaskColumn('error')).toBe('human_review');
    expect(getTaskColumn('queue')).toBe('queue');
  });
});

describe('getAllowedTaskMoves', () => {
  it('lists the allowed destinations for each column', () => {
    expect(getAllowedTaskMoves('backlog')).toEqual(['queue', 'in_progress']);
    expect(getAllowedTaskMoves('queue')).toEqual(['backlog', 'in_progress']);
    expect(getAllowedTaskMoves('in_progress')).toEqual([]);
    expect(getAllowedTaskMoves('ai_review')).toEqual(['human_review']);
    expect(getAllowedTaskMoves('human_review')).toEqual(['queue', 'in_progress', 'done']);
    expect(getAllowedTaskMoves('done')).toEqual([]);
  });

  it('treats failed and PR tasks like their visual column', () => {
    expect(getAllowedTaskMoves('error')).toEqual(getAllowedTaskMoves('human_review'));
    expect(getAllowedTaskMoves('pr_created')).toEqual([]);
  });

  it('never lists the current column', () => {
    for (const column of TASK_STATUS_COLUMNS) {
      expect(getAllowedTaskMoves(column)).not.toContain(column);
    }
  });
});

describe('canMoveTask', () => {
  it('allows only listed moves', () => {
    expect(canMoveTask('backlog', 'in_progress')).toBe(true);
    expect(canMoveTask('backlog', 'done')).toBe(false);
    expect(canMoveTask('human_review', 'backlog')).toBe(false);
    expect(canMoveTask('error', 'in_progress')).toBe(true);
    expect(canMoveTask('in_progress', 'backlog')).toBe(false);
    expect(canMoveTask('done', 'human_review')).toBe(false);
  });

  it('rejects moves within the same column', () => {
    expect(canMoveTask('error', 'human_review')).toBe(false);
    expect(canMoveTask('pr_created', 'done')).toBe(false);
  });
});
