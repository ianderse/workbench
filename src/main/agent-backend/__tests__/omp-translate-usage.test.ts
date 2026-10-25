import { describe, expect, it } from 'vitest';
import { createOmpTranslator } from '../omp-translate';
import type { ClaudeResultMessage } from '../../claude-code/stream-types';

const reply = (provider: string, model: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'message_end',
  message: {
    role: 'assistant', provider, model, stopReason: 'stop', content: [{ type: 'text', text: 'ok' }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...usage },
    ...extra,
  },
});

describe('omp translator usage', () => {
  it('sums tokens, cost and duration per provider and model over a run', () => {
    const translator = createOmpTranslator();
    translator.translate({ type: 'session', id: 's1' });
    translator.translate(reply('omlx', 'qwen', { input: 100, output: 10, cacheRead: 5 }, { duration: 2000, timestamp: 1000 }));
    translator.translate(reply('omlx', 'qwen', { input: 50, output: 20, cacheWrite: 7, cost: { total: 0.25 } }, { duration: 3000, timestamp: 5000 }));
    translator.translate(reply('anthropic', 'claude-opus-5-5', { input: 9, output: 1 }, { timestamp: 9000 }));

    const usage = translator.usage;
    expect(usage).toHaveLength(2);
    const local = usage.find((row) => row.model === 'qwen')!;
    expect(local).toMatchObject({
      provider: 'omlx', input: 150, output: 30, cacheRead: 5, cacheWrite: 7, costUsd: 0.25,
      durationMs: 5000, requests: 2, failures: 0, msFrom: 1000, msTo: 5000,
    });
    expect(usage.find((row) => row.model === 'claude-opus-5-5')).toMatchObject({ provider: 'anthropic', input: 9, output: 1, requests: 1 });
  });

  it('marks a model other than the one the run started on as a fallback and counts failures', () => {
    const translator = createOmpTranslator();
    translator.translate(reply('omlx', 'qwen', { input: 1, output: 1 }));
    translator.translate(reply('omlx', 'qwen', { input: 0, output: 0 }, { stopReason: 'error', errorMessage: 'busy' }));
    translator.translate(reply('openai-codex', 'gpt-5', { input: 4, output: 4 }));

    const [qwen, gpt] = translator.usage;
    expect(qwen.fallback).toBe(false);
    expect(qwen.failures).toBe(1);
    expect(gpt.fallback).toBe(true);
  });

  it('attaches the usage to the result message', () => {
    const translator = createOmpTranslator();
    translator.translate({ type: 'session', id: 's1' });
    translator.translate(reply('omlx', 'qwen', { input: 3, output: 2 }));
    const result = translator.translate({ type: 'agent_end', messages: [] }).find((m) => m.type === 'result') as ClaudeResultMessage;
    expect(result.omp_usage).toEqual([expect.objectContaining({ model: 'qwen', input: 3, output: 2 })]);
  });

  it('counts the last message of agent_end when the stream missed it, once', () => {
    const translator = createOmpTranslator();
    const message = reply('omlx', 'qwen', { input: 8, output: 2 }).message;
    translator.translate({ type: 'agent_end', messages: [message] });
    expect(translator.usage).toHaveLength(1);
    expect(translator.usage[0].input).toBe(8);
  });
});
