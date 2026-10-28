import { describe, expect, it } from 'vitest';
import type { PhaseProgressState } from '../../shared/types/task-throughput';
import { evaluatePhaseProgress, type PhaseProgressEvent } from './phase-progress';

const before = { repositoryFingerprint: 'same-tree', failedChecks: ['test command'], openFindings: ['A major bug remains'] };
function event(key: string, partial: Partial<PhaseProgressEvent> = {}): PhaseProgressEvent {
  return { phaseKey: key, phase: 'revise', completed: true, successful: true, numTurns: 12, before, after: before, at: '2026-10-28T20:00:00Z', ...partial };
}

describe('phase progress policy', () => {
  it('warns after repeated settled work, requests one fresh context and one authorized fallback, then stops', () => {
    let state: PhaseProgressState | undefined;
    const policy = { allowFallback: true, fallbackAvailable: true };
    const actions = [];
    for (let i = 0; i < 5; i++) {
      const evaluation = evaluatePhaseProgress(state, event(String(i)), policy);
      state = evaluation.state; actions.push(evaluation.action);
    }
    expect(actions).toEqual(['none', 'warn', 'fresh-context', 'configured-fallback', 'stalled']);
    expect(state).toMatchObject({ consecutiveNoProgress: 5, freshContextRecoveries: 1, fallbackRecoveries: 1 });
    const repeated = evaluatePhaseProgress(state, event('4'), policy);
    expect(repeated).toEqual({ state, action: 'none' });
  });

  it.each([{ allowFallback: false }, { allowFallback: true, modelPinned: true }, { allowFallback: true, fallbackAvailable: false }])('never invents a fallback route or bypasses a pin: %j', (policy) => {
    let state: PhaseProgressState | undefined;
    const actions = [];
    for (let i = 0; i < 4; i++) {
      const result = evaluatePhaseProgress(state, event(String(i)), policy);
      state = result.state; actions.push(result.action);
    }
    expect(actions).toEqual(['none', 'warn', 'fresh-context', 'stalled']);
    expect(state?.fallbackRecoveries).toBe(0);
  });

  it('does not interrupt running tools, model calls, provider retries, cooldown holds, short work or an ordinary resync', () => {
    const cases: Partial<PhaseProgressEvent>[] = [
      { completed: false }, { pendingWork: true }, { successful: false }, { providerFailure: true }, { cooldown: true }, { numTurns: 2 }, { phase: 'resync', continued: false },
    ];
    let state: PhaseProgressState | undefined;
    for (const [i, partial] of cases.entries()) {
      const result = evaluatePhaseProgress(state, event(String(i), partial));
      expect(result.action).toBe('none'); state = result.state;
    }
    expect(state?.consecutiveNoProgress).toBe(0);
  });

  it('resets the stall count for a real commit/diff change, improved checks or resolved findings', () => {
    const start = evaluatePhaseProgress(undefined, event('first')).state;
    for (const after of [
      { ...before, repositoryFingerprint: 'changed-commit-or-content' },
      { ...before, failedChecks: [] },
      { ...before, openFindings: [] },
    ]) {
      const result = evaluatePhaseProgress(start, event('improved', { after }));
      expect(result.action).toBe('none'); expect(result.state.consecutiveNoProgress).toBe(0);
    }
    expect(start.consecutiveNoProgress).toBe(1);
  });

  it('recognizes an unchanged validation-repair-validation cycle without counting the initial finding as a stall', () => {
    const first = evaluatePhaseProgress(undefined, event('validation-1', { phase: 'validate', numTurns: 2 }));
    expect(first.state.consecutiveNoProgress).toBe(0);
    const revise = evaluatePhaseProgress(first.state, event('repair', { numTurns: 3 }));
    const second = evaluatePhaseProgress(revise.state, event('validation-2', { phase: 'validate', numTurns: 2, after: { ...before, openFindings: ['  A MAJOR   bug remains '] } }));
    expect(second.state.consecutiveNoProgress).toBe(1);
    const third = evaluatePhaseProgress(second.state, event('validation-3', { phase: 'validate', numTurns: 1 }));
    expect(third.action).toBe('warn');
    const passed = evaluatePhaseProgress(third.state, event('passed', { phase: 'validate', after: { ...before, failedChecks: [], openFindings: [] } }));
    expect(passed.state.consecutiveNoProgress).toBe(0);
  });

  it('survives persisted-state replay without repeating recovery or treating log activity as evidence', () => {
    let state: PhaseProgressState | undefined;
    for (const key of ['one', 'two', 'three']) state = evaluatePhaseProgress(state, event(key)).state;
    const restored = JSON.parse(JSON.stringify(state)) as PhaseProgressState;
    expect(evaluatePhaseProgress(restored, event('three')).action).toBe('none');
    expect(evaluatePhaseProgress(restored, event('four')).action).toBe('stalled');
    expect(restored.freshContextRecoveries).toBe(1);
  });
});
