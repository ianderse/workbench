import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunClaudeText = vi.fn();
vi.mock('../../../claude-code/run-text', () => ({
  runClaudeText: (...args: unknown[]) => mockRunClaudeText(...args),
}));

import { resolveMergeConflict, createMergeResolverFn } from '../merge-resolver';
import type { MergeResolverConfig } from '../merge-resolver';

function baseConfig(overrides: Partial<MergeResolverConfig> = {}): MergeResolverConfig {
  return {
    systemPrompt: 'You are a merge conflict resolver.',
    userPrompt: '<<<\nHEAD version\n===\nIncoming version\n>>>',
    ...overrides,
  };
}

describe('resolveMergeConflict', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns success with trimmed resolved text', async () => {
    mockRunClaudeText.mockResolvedValue({ text: '  merged code  ' });
    const result = await resolveMergeConflict(baseConfig());
    expect(result).toEqual({ success: true, text: 'merged code' });
  });

  it('runs Claude Code with the prompts, no tools, sonnet and low effort by default', async () => {
    mockRunClaudeText.mockResolvedValue({ text: 'merged' });
    await resolveMergeConflict(baseConfig());
    const options = mockRunClaudeText.mock.calls[0][0];
    expect(options.systemPrompt).toBe('You are a merge conflict resolver.');
    expect(options.prompt).toContain('HEAD version');
    expect(options.model).toBe('sonnet');
    expect(options.effort).toBe('low');
    expect(options.tools).toBeUndefined();
  });

  it('passes a custom model and effort', async () => {
    mockRunClaudeText.mockResolvedValue({ text: 'merged' });
    await resolveMergeConflict(baseConfig({ model: 'opus', effort: 'high' }));
    expect(mockRunClaudeText.mock.calls[0][0]).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('strips a code fence wrapping the whole answer', async () => {
    mockRunClaudeText.mockResolvedValue({ text: '```ts\nconst a = 1;\n```' });
    const result = await resolveMergeConflict(baseConfig());
    expect(result.text).toBe('const a = 1;');
  });

  it('fails on an empty answer', async () => {
    mockRunClaudeText.mockResolvedValue({ text: '   ' });
    const result = await resolveMergeConflict(baseConfig());
    expect(result.success).toBe(false);
    expect(result.text).toBe('');
  });

  it('fails with the error message when the run throws', async () => {
    mockRunClaudeText.mockRejectedValue(new Error('Claude Code run timed out'));
    const result = await resolveMergeConflict(baseConfig());
    expect(result).toEqual({ success: false, text: '', error: 'Claude Code run timed out' });
  });
});

describe('createMergeResolverFn', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the resolved text, or an empty string on failure', async () => {
    const resolve = createMergeResolverFn('haiku', 'medium');
    mockRunClaudeText.mockResolvedValueOnce({ text: 'resolved' });
    expect(await resolve('sys', 'user')).toBe('resolved');
    expect(mockRunClaudeText.mock.calls[0][0]).toMatchObject({ systemPrompt: 'sys', prompt: 'user', model: 'haiku', effort: 'medium' });

    mockRunClaudeText.mockRejectedValueOnce(new Error('boom'));
    expect(await resolve('sys', 'user')).toBe('');
  });
});
