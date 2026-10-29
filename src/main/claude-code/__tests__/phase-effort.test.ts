import { describe, expect, it } from 'vitest';
import type { ClaudeEffort, ClaudeRunPhaseName, TaskTriage } from '../../../shared/types/claude-code';
import { phaseEffort } from '../phase-effort';

const automatic: TaskTriage = {
  model: 'opus', effort: 'max', needsPlan: true, scope: 'large', title: 'Recovery subsystem',
  reasoning: 'Architecture and concurrency require care', verification: [], source: 'auto',
};

describe('phase effort policy', () => {
  it('reserves deep task reasoning for architecture and review judgment instead of every step', () => {
    expect(phaseEffort(automatic, 'plan')).toBe('max');
    expect(phaseEffort(automatic, 'implement')).toBe('high');
    expect(phaseEffort({ ...automatic, scope: 'medium' }, 'implement')).toBe('medium');
    expect(phaseEffort(automatic, 'validate')).toBe('high');
    expect(phaseEffort(automatic, 'validate', { cleanIndependentReview: true })).toBe('medium');
    expect(phaseEffort(automatic, 'resync')).toBe('medium');
    expect(phaseEffort(automatic, 'resync', { continuesImplementation: true })).toBe('high');
    expect(phaseEffort({ ...automatic, scope: 'medium' }, 'resync', { continuesImplementation: true })).toBe('medium');
    expect(phaseEffort(automatic, 'resync', { mergeFix: true })).toBe('high');
    expect(phaseEffort(automatic, 'revise')).toBe('high');
    expect(phaseEffort(automatic, 'spec_review')).toBe('max');
    expect(phaseEffort(automatic, 'review')).toBe('max');
  });

  it('keeps design depth and lifts low-effort architectural planning', () => {
    expect(phaseEffort({ ...automatic, effort: 'low' }, 'plan')).toBe('high');
    expect(phaseEffort({ ...automatic, effort: 'medium' }, 'implement', { design: true })).toBe('high');
    expect(phaseEffort(automatic, 'validate', { design: true })).toBe('max');
  });

  it('does not inflate mechanical work or disregard explicit effort choices', () => {
    const phases: ClaudeRunPhaseName[] = ['plan', 'implement', 'validate', 'revise', 'resync', 'spec_review'];
    const efforts: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    for (const effort of efforts) {
      for (const phase of phases) {
        expect(phaseEffort({ ...automatic, effort, pinned: { effort: true } }, phase, { design: true, mergeFix: true, cleanIndependentReview: true })).toBe(effort);
        expect(phaseEffort({ ...automatic, effort, source: 'fixed' }, phase, { design: true, mergeFix: true })).toBe(effort);
        expect(phaseEffort({ ...automatic, effort, source: 'fallback' }, phase, { design: true, mergeFix: true })).toBe(effort);
      }
    }
    expect(phaseEffort({ ...automatic, effort: 'low' }, 'implement')).toBe('low');
    expect(phaseEffort({ ...automatic, effort: 'medium' }, 'revise')).toBe('medium');
    // Pinning only the model still permits the automatic effort policy.
    expect(phaseEffort({ ...automatic, pinned: { model: true } }, 'implement')).toBe('high');
  });
});
