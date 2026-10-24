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
