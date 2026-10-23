/**
 * Pricing one Claude Code request from the tokens it used. The figures are checked against what
 * Claude Code itself reported for the same tokens in a real transcript.
 */
import { describe, expect, it } from 'vitest';
import { requestCostUsd } from '../claude-code/session-pricing';

describe('request pricing', () => {
  it('prices a request the way Claude Code reported it', () => {
    // From a real transcript's `modelUsage`: 1270 input and 20 output tokens cost $0.000137
    expect(requestCostUsd('claude-haiku-5-5', { input_tokens: 1270, output_tokens: 20 })).toBeCloseTo(0.000137, 9);
  });

  it('charges the one hour cache more than the five minute one', () => {
    const usage = { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } };
    const short = { cache_creation: { ephemeral_5m_input_tokens: 1_000_000 } };

    // Claude Opus 5 input is $5 per million: 2x to write for an hour, 1.25x for five minutes
    expect(requestCostUsd('claude-opus-5', usage)).toBeCloseTo(10, 6);
    expect(requestCostUsd('claude-opus-5', short)).toBeCloseTo(6.25, 6);
  });

  it('prices cached reads at a fraction of the input price', () => {
    expect(requestCostUsd('claude-opus-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.5, 6);
    expect(requestCostUsd('claude-sonnet-5-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 6);
  });

  it('counts the cache writes of a transcript that does not say which cache they went to', () => {
    expect(requestCostUsd('claude-opus-5', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(6.25, 6);
  });

  it('reads a model name that carries a cloud provider prefix or a date', () => {
    expect(requestCostUsd('us.anthropic.claude-opus-5-5', { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
    expect(requestCostUsd('claude-opus-5-5-20260401', { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
  });

  it('tells the newer models of a family apart', () => {
    expect(requestCostUsd('claude-opus-5', { output_tokens: 1_000_000 })).toBeCloseTo(25, 6);
    expect(requestCostUsd('claude-opus-5-5', { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
  });

  it('prices nothing for a model it does not know, or usage it was not given', () => {
    expect(requestCostUsd('claude-next-7', { output_tokens: 1_000_000 })).toBe(0);
    expect(requestCostUsd(undefined, { output_tokens: 1_000_000 })).toBe(0);
    expect(requestCostUsd('claude-opus-5', undefined)).toBe(0);
    expect(requestCostUsd('claude-opus-5', { output_tokens: -5 })).toBe(0);
  });
});
