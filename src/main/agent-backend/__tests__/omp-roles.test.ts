import { describe, expect, it, vi } from 'vitest';
import { getOmpAdvisorPolicy, parseOmpAdvisorEnabled, parseOmpRoles, refreshOmpRoles, resetOmpRolesForTests } from '../omp-roles';
import * as runtime from '../../platform/runtime-exec';
import * as command from '../omp-command';

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

it('reads effective advisor enablement without guessing from the configured advisor model', async () => {
  expect(parseOmpAdvisorEnabled('{"advisor.enabled":{"value":true}}')).toBe(true);
  expect(parseOmpAdvisorEnabled('{"advisor.enabled":{"value":false}}')).toBe(false);
  expect(parseOmpAdvisorEnabled('{}')).toBeUndefined();
  expect(parseOmpAdvisorEnabled('{"advisor.enabled":{"value":"true"}}')).toBeUndefined();
  expect(parseOmpAdvisorEnabled('bad')).toBeUndefined();
  resetOmpRolesForTests({ default: 'omlx/worker', advisor: 'openai-codex/advisor' }, {}, false);
  expect(await getOmpAdvisorPolicy()).toEqual({ enabled: false, model: 'openai-codex/advisor' });
});

it.each(['failed', 'malformed'])('drops inherited advisor authorization after a %s refresh while retaining cached worker routes', async (mode) => {
  resetOmpRolesForTests({ default: 'omlx/worker', advisor: 'cloud/advisor' }, {}, true);
  const resolve = vi.spyOn(command, 'resolveOmpCommand').mockResolvedValue('omp');
  const run = vi.spyOn(runtime, 'runTool');
  if (mode === 'failed') run.mockRejectedValue(new Error('CLI unavailable'));
  else run.mockResolvedValue({ stdout: 'not json', stderr: '' });
  try {
    expect(await refreshOmpRoles()).toEqual({ default: 'omlx/worker', advisor: 'cloud/advisor' });
    expect(await getOmpAdvisorPolicy()).toEqual({ enabled: undefined, model: 'cloud/advisor' });
  } finally { run.mockRestore(); resolve.mockRestore(); }
});

it('does not overwrite a replacement role snapshot when an earlier config read finishes late', async () => {
  resetOmpRolesForTests({ default: 'old/model' }, {}, true);
  const resolve = vi.spyOn(command, 'resolveOmpCommand').mockResolvedValue('omp');
  let release!: (value: { stdout: string; stderr: string }) => void;
  const run = vi.spyOn(runtime, 'runTool').mockImplementation(() => new Promise((done) => { release = done; }));
  try {
    const pending = refreshOmpRoles();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    resetOmpRolesForTests({ default: 'fixture/worker', advisor: 'fixture/advisor' }, {}, false);
    release({ stdout: JSON.stringify({ modelRoles: { value: { default: 'late/live-model' } }, 'advisor.enabled': { value: true } }), stderr: '' });
    await pending;
    expect(await getOmpAdvisorPolicy()).toEqual({ enabled: false, model: 'fixture/advisor' });
  } finally { run.mockRestore(); resolve.mockRestore(); }
});

it('reads configured fallback chains and rejects malformed entries', async () => {
  const { parseOmpFallbackChains } = await import('../omp-roles');
  expect(parseOmpFallbackChains(JSON.stringify({ 'retry.fallbackChains': { value: { plan: [' openai-codex/gpt-6-astra:medium '], 'anthropic/*': ['openai-codex/gpt-6.1-sol'], invalid: [2], bad: {} } } }))).toEqual({ plan: ['openai-codex/gpt-6-astra:medium'], 'anthropic/*': ['openai-codex/gpt-6.1-sol'] });
  expect(parseOmpFallbackChains('broken')).toEqual({});
});
