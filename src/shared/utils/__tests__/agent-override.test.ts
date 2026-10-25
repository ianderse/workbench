import { describe, it, expect } from 'vitest';
import { resolveEffectiveAgent, normalizeAgentOverride } from '../agent-override';
import { pinnedModelLabel } from '../agent-override-labels';

describe('resolveEffectiveAgent', () => {
  it('follows the app backend without an override', () => {
    expect(resolveEffectiveAgent(undefined, 'omp')).toEqual({ backend: 'omp', model: undefined, effort: undefined, backendPinned: false });
  });
  it('lets the task pin Claude under an OMP app', () => {
    expect(resolveEffectiveAgent({ backend: 'claude', model: ' claude-opus-5-5 ', effort: 'high' }, 'omp'))
      .toEqual({ backend: 'claude', model: 'claude-opus-5-5', effort: 'high', backendPinned: true });
  });
  it('keeps the app backend when only model/effort are pinned, and ignores bad values', () => {
    expect(resolveEffectiveAgent({ model: 'opus' }, 'omp').backend).toBe('omp');
    expect(resolveEffectiveAgent({ backend: 'bogus' as never, effort: 'huge' as never }, 'claude')).toMatchObject({ backend: 'claude', effort: undefined });
  });
});

describe('normalizeAgentOverride', () => {
  it('drops empty overrides and blank models', () => {
    expect(normalizeAgentOverride({ model: '  ' })).toBeUndefined();
    expect(normalizeAgentOverride({ backend: 'omp', model: ' x/y ' })).toEqual({ backend: 'omp', model: 'x/y' });
  });
});

describe('pinnedModelLabel', () => {
  it('labels Claude and OMP pins', () => {
    expect(pinnedModelLabel(undefined, 'claude')).toBeUndefined();
    expect(pinnedModelLabel({ backend: 'claude', model: 'opus' }, 'omp')).toBe('Opus 5.5');
    expect(pinnedModelLabel({ backend: 'omp', model: 'omlx/Qwen3.8-27B' }, 'claude')).toBe('OMP · Qwen3.8-27B');
    expect(pinnedModelLabel({ backend: 'omp', model: 'opus' }, 'claude', { opus: 'omlx/Big' })).toBe('OMP · Big');
  });
});
