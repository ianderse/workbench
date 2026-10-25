import { describe, it, expect } from 'vitest';
import { canResumeTask, isRunFinished, reviewInterruption, stuckTaskStartupAction } from '../task-resume';
import type { Task } from '../../types/task';
import type { ClaudeRunInfo, ClaudeRunPhase } from '../../types/claude-code';

const phase = (name: ClaudeRunPhase['name'], fields: Partial<ClaudeRunPhase> = {}): ClaudeRunPhase => ({
  name,
  startedAt: '2026-01-01T00:00:00Z',
  ...fields,
});
const run = (...phases: ClaudeRunPhase[]): ClaudeRunInfo =>
  ({ version: 1, phases, subagents: [], totalCostUsd: 0, updatedAt: '' }) as ClaudeRunInfo;
const task = (fields: Partial<Task>): Task => ({ id: 't', specId: '001-t', ...fields }) as Task;

const stoppedImplement = run(phase('triage', { endedAt: 'x' }), phase('implement', { endedAt: 'x', isError: true, error: 'Stopped' }));

describe('canResumeTask', () => {
  it('resumes a stopped task with an unfinished step', () => {
    expect(canResumeTask(task({ status: 'human_review', reviewReason: 'stopped', claudeRun: stoppedImplement }))).toBe(true);
  });

  it('resumes a failed task (Error)', () => {
    expect(canResumeTask(task({ status: 'error', claudeRun: stoppedImplement }))).toBe(true);
    expect(canResumeTask(task({ status: 'error' }))).toBe(true);
  });

  it('resumes a failed review step', () => {
    const failedValidate = run(phase('implement', { endedAt: 'x' }), phase('validate', { endedAt: 'x', isError: true }));
    expect(canResumeTask(task({ status: 'human_review', reviewReason: 'errors', claudeRun: failedValidate }))).toBe(true);
  });

  it('does not resume a run whose last step finished', () => {
    const done = run(phase('implement', { endedAt: 'x' }), phase('validate', { endedAt: 'x' }));
    expect(canResumeTask(task({ status: 'human_review', reviewReason: 'errors', claudeRun: done }))).toBe(false);
    expect(canResumeTask(task({ status: 'human_review', reviewReason: 'stopped', claudeRun: done }))).toBe(false);
  });

  it('knows a finished implementation is the end when validation is off', () => {
    const impl = run(phase('implement', { endedAt: 'x' }));
    expect(isRunFinished(impl, true)).toBe(false);
    expect(isRunFinished(impl, false)).toBe(true);
  });

  it('ignores other states, running tasks and archived tasks', () => {
    expect(canResumeTask(task({ status: 'in_progress', claudeRun: stoppedImplement }))).toBe(false);
    expect(canResumeTask(task({ status: 'human_review', reviewReason: 'completed', claudeRun: stoppedImplement }))).toBe(false);
    expect(canResumeTask(task({ status: 'done', claudeRun: stoppedImplement }))).toBe(false);
    expect(canResumeTask(task({ status: 'error', metadata: { archivedAt: 'x' } }))).toBe(false);
  });
});

describe('stuckTaskStartupAction', () => {
  const unfinished = { phases: [{ name: 'implement', startedAt: '2026-10-25T03:47:01Z' }] } as never;
  const finished = { phases: [{ name: 'validate', startedAt: '2026-10-25T04:30:00Z', endedAt: '2026-10-25T04:40:00Z' }] } as never;

  it('resumes a task left running with an unfinished run, and moves a finished one to review', () => {
    expect(stuckTaskStartupAction({ status: 'in_progress', metadata: {} } as never, unfinished, false)).toBe('resume');
    expect(stuckTaskStartupAction({ status: 'ai_review', metadata: {} } as never, unfinished, false)).toBe('resume');
    expect(stuckTaskStartupAction({ status: 'in_progress', metadata: {} } as never, finished, false)).toBe('review');
  });

  it('leaves tasks alone that are running, archived or were not left running', () => {
    expect(stuckTaskStartupAction({ status: 'in_progress', metadata: {} } as never, unfinished, true)).toBeNull();
    expect(stuckTaskStartupAction({ status: 'in_progress', metadata: { archivedAt: 'x' } } as never, unfinished, false)).toBeNull();
    expect(stuckTaskStartupAction({ status: 'queue', metadata: {} } as never, unfinished, false)).toBeNull();
    expect(stuckTaskStartupAction({ status: 'human_review', metadata: {} } as never, unfinished, false)).toBeNull();
  });
});

describe('reviewInterruption', () => {
  const review = (fields: Partial<Task>) => task({ status: 'human_review', subtasks: [{ status: 'completed' }] as Task['subtasks'], ...fields });
  const doneRun = run(phase('implement', { endedAt: 'x' }), phase('validate', { endedAt: 'x' }));

  it('names a stopped task', () => {
    expect(reviewInterruption(review({ reviewReason: 'stopped', claudeRun: stoppedImplement }))).toBe('stopped');
  });

  it('names a run that ended on an unfinished step', () => {
    expect(reviewInterruption(review({ reviewReason: 'completed', claudeRun: run(phase('implement', { endedAt: 'x' })) }))).toBe('interrupted');
  });

  it('names a run whose last step failed', () => {
    expect(reviewInterruption(review({ claudeRun: stoppedImplement }))).toBe('interrupted');
  });

  it('names a run whose last step never ended', () => {
    expect(reviewInterruption(review({ claudeRun: run(phase('implement')) }))).toBe('interrupted');
  });

  it('names a review with no reason and no completed subtask', () => {
    expect(reviewInterruption(task({ status: 'human_review', subtasks: [] }))).toBe('interrupted');
  });

  it('is null for a finished run', () => {
    expect(reviewInterruption(review({ reviewReason: 'completed', claudeRun: doneRun }))).toBeNull();
  });

  it('respects validation being off', () => {
    expect(reviewInterruption(review({ claudeRun: run(phase('implement', { endedAt: 'x' })) }), false)).toBeNull();
  });

  it('is null for auto-merged, split and error reviews', () => {
    for (const reviewReason of ['auto_merged', 'split_proposed', 'errors'] as const) {
      expect(reviewInterruption(review({ reviewReason, claudeRun: stoppedImplement }))).toBeNull();
    }
  });

  it('is null outside Human Review', () => {
    expect(reviewInterruption(task({ status: 'in_progress', claudeRun: stoppedImplement }))).toBeNull();
  });
});
