import { describe, expect, it } from 'vitest';
import { summarizeUsage } from '../usage-summary';
import { classifyProvider, isLocalHost, parseModelsYmlBaseUrls } from '../provider-locality';
import { tokensCostUsd } from '../../claude-code/session-pricing';
import { formatTokens } from '../../../shared/utils/format-tokens';
import type { UsageEntry } from '../../../shared/types/usage';

const now = new Date(2026, 9, 24, 12, 0, 0);

function entry(partial: Partial<UsageEntry>): UsageEntry {
  return {
    at: new Date(2026, 9, 24, 10, 0, 0).toISOString(), job: 'implement', backend: 'omp', model: 'qwen', provider: 'omlx',
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 0, ...partial,
  };
}

const entries: UsageEntry[] = [
  entry({ taskId: 't1', input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100, durationMs: 10_000 }),
  entry({ taskId: 't1', job: 'validate', input: 500, output: 500, durationMs: 10_000, failures: 1 }),
  entry({ taskId: 't2', job: 'plan', backend: 'claude', provider: 'anthropic', model: 'claude-opus-5-5', input: 200, output: 800, costUsd: 1.5, durationMs: 4000, at: new Date(2026, 9, 20).toISOString() }),
  entry({ job: 'title', model: 'qwen-fb', fallback: true, input: 10, output: 5 }),
];

describe('classifyProvider', () => {
  it('knows local runtimes by name and cloud providers by default', () => {
    for (const name of ['omlx', 'ollama', 'lmstudio', 'LM-Studio', 'llama.cpp', 'llamacpp', 'local']) expect(classifyProvider(name)).toBe('local');
    for (const name of ['anthropic', 'openai', 'openai-codex', 'google', undefined]) expect(classifyProvider(name)).toBe('cloud');
  });

  it('lets a LAN or localhost baseUrl make any provider local, and a public one cloud', () => {
    const urls = new Map([['mybox', 'http://192.168.1.20:8080/v1'], ['dev', 'http://localhost:1234'], ['omlx', 'https://api.example.com/v1']]);
    expect(classifyProvider('mybox', urls)).toBe('local');
    expect(classifyProvider('dev', urls)).toBe('local');
    // The URL wins over the name
    expect(classifyProvider('omlx', urls)).toBe('cloud');
  });

  it('recognizes private hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.0.2', '172.20.1.1', 'studio.local', '::1', 'fd12::1']) expect(isLocalHost(host)).toBe(true);
    for (const host of ['api.anthropic.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) expect(isLocalHost(host)).toBe(false);
  });

  it('reads provider base URLs from models.yml', () => {
    const yml = [
      'providers:',
      '  omlx:',
      '    baseUrl: http://127.0.0.1:8000/v1',
      '    api: openai-completions',
      '  "remote":',
      '    baseUrl: "https://api.example.com/v1" # comment',
      'other:',
      '  x:',
      '    baseUrl: http://nope',
    ].join('\n');
    const urls = parseModelsYmlBaseUrls(yml);
    expect(urls.get('omlx')).toBe('http://127.0.0.1:8000/v1');
    expect(urls.get('remote')).toBe('https://api.example.com/v1');
    expect(urls.has('x')).toBe(false);
  });
});

describe('pricing estimate', () => {
  it('prices tokens at a model list rate', () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, 1.25x input for cache writes, per million
    const cost = tokensCostUsd('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    expect(cost).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6);
    expect(tokensCostUsd('unknown-model', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});

describe('summarizeUsage', () => {
  const summary = summarizeUsage(entries, {
    now,
    classify: (provider) => classifyProvider(provider),
    tasks: new Map([['t1', { title: 'First task', reviewRounds: 2 }]]),
  });

  it('totals tokens and cost', () => {
    expect(summary.entryCount).toBe(4);
    expect(summary.totals).toMatchObject({ input: 1710, output: 1805, cacheRead: 2000, cacheWrite: 100, costUsd: 1.5 });
    expect(summary.totals.total).toBe(1710 + 1805 + 2000 + 100);
  });

  it('groups by model with tokens per second', () => {
    const qwen = summary.byModel.find((row) => row.model === 'qwen')!;
    expect(qwen).toMatchObject({ provider: 'omlx', locality: 'local', total: 4600, output: 1000, durationMs: 20_000 });
    expect(qwen.tokensPerSecond).toBeCloseTo(50, 5);
    expect(summary.byModel[0].total).toBeGreaterThanOrEqual(summary.byModel[1].total);
  });

  it('groups by provider, job and task', () => {
    expect(summary.byProvider.map((row) => row.provider).sort()).toEqual(['anthropic', 'omlx']);
    expect(summary.byJob.find((row) => row.job === 'plan')?.total).toBe(1000);
    const t1 = summary.byTask.find((row) => row.taskId === 't1')!;
    expect(t1).toMatchObject({ title: 'First task', reviewRounds: 2, total: 3600 + 1000 });
    expect(summary.byTask.some((row) => row.taskId === 't2' && row.title === undefined)).toBe(true);
  });

  it('splits local and cloud and uses Sonnet only as the local fallback', () => {
    expect(summary.locality.local.total).toBe(3600 + 1000 + 15);
    expect(summary.locality.cloud.total).toBe(1000);
    expect(summary.locality.localShare).toBeCloseTo(4615 / 5615, 6);
    const expected = tokensCostUsd('claude-sonnet-5-5', { input: 1510, output: 1005, cacheRead: 2000, cacheWrite: 100 });
    expect(summary.locality.local.calculatedCostUsd).toBeCloseTo(expected, 8);
    expect(summary.locality.savedCostUsd).toBeCloseTo(expected, 8);
    expect(summary.locality.local.unpricedTokens).toBe(0);
    const localModel = summary.byModel.find((row) => row.model === 'qwen')!;
    expect(localModel.pricing).toMatchObject({ model: 'claude-sonnet-5-5', provider: 'anthropic', source: 'builtin', fallback: true });
  });

  it('covers the last 30 days, quiet days included', () => {
    expect(summary.byDay).toHaveLength(30);
    expect(summary.byDay[29].date).toBe('2026-10-24');
    expect(summary.byDay[29].tokens).toBe(3600 + 1000 + 15);
    expect(summary.byDay.find((day) => day.date === '2026-10-20')?.tokens).toBe(1000);
    expect(summary.byDay[0].tokens).toBe(0);
  });

  it('finds the fun facts', () => {
    expect(summary.facts.chattiest?.model).toBe('claude-opus-5-5');
    expect(summary.facts.fastest?.model).toBe('claude-opus-5-5');
    expect(summary.facts.priciestTask).toMatchObject({ taskId: 't2', calculatedCostUsd: 0.0168 });
    expect(summary.facts.fallbackRuns).toBe(1);
    expect(summary.facts.failedRequests).toBe(1);
  });

  it('handles an empty ledger', () => {
    const empty = summarizeUsage([], { now });
    expect(empty.entryCount).toBe(0);
    expect(empty.totals.total).toBe(0);
    expect(empty.locality.localShare).toBe(0);
    expect(empty.byDay).toHaveLength(30);
    expect(empty.facts.fallbackRuns).toBe(0);
  });
});

describe('formatTokens', () => {
  it('writes compact counts', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4K');
    expect(formatTokens(12_400_000)).toBe('12.4M');
    expect(formatTokens(999_960)).toBe('1M');
    expect(formatTokens(3_100_000_000)).toBe('3.1B');
    expect(formatTokens(250_000)).toBe('250K');
  });
});
