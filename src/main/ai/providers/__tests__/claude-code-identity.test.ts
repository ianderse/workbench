import { describe, it, expect, vi } from 'vitest';

import { CLAUDE_CODE_IDENTITY, prependClaudeCodeIdentity, withClaudeCodeIdentity } from '../claude-code-identity';

const identity = { type: 'text', text: CLAUDE_CODE_IDENTITY };

describe('prependClaudeCodeIdentity', () => {
  it('puts the identity before a string system prompt', () => {
    expect(prependClaudeCodeIdentity('Agent prompt')).toEqual([identity, { type: 'text', text: 'Agent prompt' }]);
  });

  it('puts the identity before system blocks, keeping their cache control', () => {
    const blocks = [{ type: 'text', text: 'Agent prompt', cache_control: { type: 'ephemeral' } }];
    expect(prependClaudeCodeIdentity(blocks)).toEqual([identity, ...blocks]);
  });

  it('adds the identity when there is no system prompt, and does not add it twice', () => {
    expect(prependClaudeCodeIdentity(undefined)).toEqual([identity]);
    expect(prependClaudeCodeIdentity([identity])).toEqual([identity]);
  });
});

describe('withClaudeCodeIdentity', () => {
  it('rewrites the system prompt of Messages API requests only', async () => {
    const baseFetch = vi.fn(async () => new Response('{}'));
    const identityFetch = withClaudeCodeIdentity(baseFetch as unknown as typeof fetch);
    const body = JSON.stringify({ model: 'claude-opus-4-6', system: 'Agent prompt', messages: [] });

    await identityFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });
    const sent = JSON.parse((baseFetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.system).toEqual([identity, { type: 'text', text: 'Agent prompt' }]);
    expect(sent.model).toBe('claude-opus-4-6');

    await identityFetch('https://api.anthropic.com/v1/models', { method: 'GET' });
    expect((baseFetch.mock.calls[1] as unknown as [string, RequestInit])[1]).toEqual({ method: 'GET' });
  });
});
