/**
 * Claude Code identity for subscription (OAuth) requests.
 *
 * Anthropic only accepts requests made with a Claude subscription token when the system prompt
 * starts with the Claude Code identity; any other request is rejected with HTTP 429
 * `rate_limit_error` ("Error"), which the AI SDK retries and then reports as
 * "Failed after 3 attempts. Last error: Error". The agent's own prompt follows as a second block.
 */

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

type SystemBlock = { type: 'text'; text: string; [key: string]: unknown };

/** The request's system prompt with the identity as its first block */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identity: SystemBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY };
  if (typeof system === 'string') {
    return system.trim() ? [identity, { type: 'text', text: system }] : [identity];
  }
  if (Array.isArray(system)) {
    const blocks = system as SystemBlock[];
    return blocks[0]?.text === CLAUDE_CODE_IDENTITY ? blocks : [identity, ...blocks];
  }
  return [identity];
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** fetch for subscription requests: adds the Claude Code identity to every Messages API call */
export function withClaudeCodeIdentity(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === 'string' && /\/messages(\?|$)/.test(requestUrl(input))) {
      try {
        const body = JSON.parse(init.body) as { system?: unknown };
        body.system = prependClaudeCodeIdentity(body.system);
        return baseFetch(input, { ...init, body: JSON.stringify(body) });
      } catch {
        // Not JSON: send it unchanged
      }
    }
    return baseFetch(input, init);
  };
}
