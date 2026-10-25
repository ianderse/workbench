import { describe, it, expect } from 'vitest';
import { canResumeTask, isRunFinished } from '../task-resume';
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
