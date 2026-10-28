import { describe, expect, it } from 'vitest';
import { parseOmpModels, parseOmpVersion } from './omp-detect-parse';

describe('omp detect parsing', () => {
  it('reads the version', () => {
    expect(parseOmpVersion('omp/18.11.0\n')).toBe('18.11.0');
    expect(parseOmpVersion('')).toBeUndefined();
  });

  it('parses JSON output', () => {
    const json = JSON.stringify({ models: [{ provider: 'ollama', id: 'qwen3:8b', selector: 'ollama/qwen3:8b' }] });
    expect(parseOmpModels(json)).toEqual([{ provider: 'ollama', id: 'qwen3:8b', selector: 'ollama/qwen3:8b' }]);
  });

  it('preserves provider-specific catalog rates and their meaning', () => {
    const cost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
    const unknown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const json = JSON.stringify({ models: [
      { provider: 'openai-codex', id: 'model', name: 'Model', cost, pricingStatus: 'fixed' },
      { provider: 'local', id: 'local-model', cost: unknown, pricingStatus: 'unknown' },
    ] });
    expect(parseOmpModels(json)).toEqual([
      { provider: 'openai-codex', id: 'model', selector: 'openai-codex/model', name: 'Model', cost, pricingStatus: 'fixed' },
      { provider: 'local', id: 'local-model', selector: 'local/local-model', cost: unknown, pricingStatus: 'unknown' },
    ]);
  });

  it('omits incomplete or invalid pricing without losing the model list', () => {
    const valid = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
    const invalidCosts = [undefined, null, {}, { input: 2, output: 10 }, { ...valid, input: -1 }, { ...valid, output: '10' }, { ...valid, cacheRead: Infinity }];
    const json = JSON.stringify({ models: [
      null,
      ...invalidCosts.map((cost, index) => ({ provider: 'provider', id: `model-${index}`, cost, pricingStatus: 'invalid', name: 123, selector: 123 })),
    ] });
    expect(parseOmpModels(json)).toEqual(invalidCosts.map((_, index) => ({
      provider: 'provider', id: `model-${index}`, selector: `provider/model-${index}`,
    })));
  });

  it('parses the table', () => {
    const table = [
      'omlx (2)',
      '┌─────┬─────────┐',
      '│ model │ context │',
      '├─────┼─────────┤',
      '│ qwen-a │ 32K │',
      '│ qwen-b │ - │',
      '└─────┴─────────┘',
    ].join('\n');
    expect(parseOmpModels(table).map((m) => m.selector)).toEqual(['omlx/qwen-a', 'omlx/qwen-b']);
  });
});
