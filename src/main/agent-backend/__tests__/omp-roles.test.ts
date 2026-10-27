import { describe, expect, it } from 'vitest';
import { parseOmpRoles } from '../omp-roles';

describe('parseOmpRoles', () => {
  it('reads modelRoles.value from `omp config list --json`', () => {
    const out = JSON.stringify({
      enabledModels: { value: [] },
      modelRoles: { value: { default: 'omlx/a', plan: 'anthropic/b', empty: '', bad: 3 }, type: 'record' },
    });
    expect(parseOmpRoles(out)).toEqual({ default: 'omlx/a', plan: 'anthropic/b' });
  });

  it('returns undefined for unusable output and {} for no roles', () => {
    expect(parseOmpRoles('not json')).toBeUndefined();
    expect(parseOmpRoles('{}')).toBeUndefined();
    expect(parseOmpRoles('{"modelRoles":{"value":[]}}')).toBeUndefined();
    expect(parseOmpRoles('{"modelRoles":{"value":{}}}')).toEqual({});
  });
});

it('reads configured fallback chains and rejects malformed entries', async () => {
  const { parseOmpFallbackChains } = await import('../omp-roles');
  expect(parseOmpFallbackChains(JSON.stringify({ 'retry.fallbackChains': { value: { plan: [' openai-codex/gpt-6-astra:medium '], 'anthropic/*': ['openai-codex/gpt-6.1-sol'], invalid: [2], bad: {} } } }))).toEqual({ plan: ['openai-codex/gpt-6-astra:medium'], 'anthropic/*': ['openai-codex/gpt-6.1-sol'] });
  expect(parseOmpFallbackChains('broken')).toEqual({});
});
