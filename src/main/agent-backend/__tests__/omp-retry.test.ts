import { describe, expect, it } from 'vitest';
import { classifyOmpErrorText, classifyOmpFailure, ompRetryDelayMs } from '../omp-retry';

describe('ompRetryDelayMs', () => {
  it('backs off 30s, 2m, 5m and then stops', () => {
    expect([1, 2, 3].map(ompRetryDelayMs)).toEqual([30_000, 120_000, 300_000]);
    expect(ompRetryDelayMs(4)).toBeUndefined();
    expect(ompRetryDelayMs(0)).toBeUndefined();
  });
});

describe('classifyOmpErrorText', () => {
  it.each([
    'OpenAI completions stream stalled while waiting for the next event',
    'connect ECONNREFUSED 127.0.0.1:8000',
    'read ECONNRESET',
    'fetch failed',
    'socket hang up',
    '503 Service Unavailable',
    '502 Bad Gateway',
    '429 Too Many Requests',
    'The server is overloaded, rate limit hit',
    'terminated',
    'other side closed',
    'Server disconnected without sending a response',
  ])('treats "%s" as transient', (text) => {
    expect(classifyOmpErrorText(text)).toBe('transient');
  });

  it.each([
    'Error Code credit_balance_exhausted: your credit balance is too low',
    'Built-in tool unavailable in this session: find',
    'Codex error event: The usage limit has been reached (code=usage_limit_reached)',
    '401 Unauthorized',
    '403 Forbidden',
    'Model not found: omlx/nope',
    'error: unknown option --frobnicate',
    '400 invalid_request_error: bad schema',
    'something odd happened',
    '',
  ])('treats "%s" as permanent', (text) => {
    expect(classifyOmpErrorText(text)).toBe('permanent');
  });
});

describe('classifyOmpFailure', () => {
  it('decides by the worker model when a fallback model failed afterwards', () => {
    expect(classifyOmpFailure({
      errors: [
        { text: 'OpenAI completions stream stalled while waiting for the next event' },
        { text: 'Codex error event: The usage limit has been reached (code=usage_limit_reached)', fallback: true },
      ],
    })).toBe('transient');
  });

  it('stays permanent when the worker model itself failed permanently', () => {
    expect(classifyOmpFailure({
      errors: [{ text: 'Error Code credit_balance_exhausted' }, { text: 'fetch failed', fallback: true }],
    })).toBe('permanent');
  });

  it('uses the last error when only a fallback reported one', () => {
    expect(classifyOmpFailure({ errors: [{ text: 'fetch failed', fallback: true }] })).toBe('transient');
  });

  it('falls back to the final text, a kill signal, and never retries a timeout', () => {
    expect(classifyOmpFailure({ fallbackText: 'ECONNRESET' })).toBe('transient');
    expect(classifyOmpFailure({ signal: 'SIGKILL' })).toBe('transient');
    expect(classifyOmpFailure({})).toBe('permanent');
    expect(classifyOmpFailure({ fallbackText: 'ECONNRESET', timedOut: true })).toBe('permanent');
  });
});
