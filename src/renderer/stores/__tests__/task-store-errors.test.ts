/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for reading why a task failed
 */
import { describe, it, expect } from 'vitest';
import { taskHasErrors } from '../task-store';
import type { Task } from '../../../shared/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', specId: '001-x', projectId: 'p1', title: 'X', description: '',
    status: 'human_review', subtasks: [], logs: [],
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides
  };
}

describe('taskHasErrors', () => {
  it('detects error tasks', () => {
    expect(taskHasErrors(makeTask({ reviewReason: 'errors' }))).toBe(true);
    expect(taskHasErrors(makeTask({ status: 'error' }))).toBe(true);
    expect(taskHasErrors(makeTask({ reviewReason: 'completed' }))).toBe(false);
  });
});
