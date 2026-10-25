import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { appendUsageEntries, readUsageEntries, usageLedgerForSpecDir, usageLedgerPath } from '../usage-ledger';
import { claudeUsageEntries, ompUsageEntries, type UsageContext } from '../usage-record';
import { backfillUsage, jobAt } from '../usage-backfill';
import { summarizeUsage } from '../usage-summary';
import type { ClaudeResultMessage } from '../../claude-code/stream-types';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (job: UsageContext['job'] = 'implement'): UsageContext => ({ ledgerFile: usageLedgerPath(root), job, taskId: '001-task', projectId: 'p1' });

describe('usage ledger', () => {
  it('derives the ledger from a task folder', () => {
    expect(usageLedgerForSpecDir(path.join(root, '.workbench', 'tasks', '001-task'))).toBe(path.join(root, '.workbench', 'usage.jsonl'));
  });

  it('appends one JSON line per entry and reads them back', async () => {
    const entries = ompUsageEntries(ctx(), [
      { provider: 'omlx', model: 'qwen', input: 10, output: 5, cacheRead: 1, cacheWrite: 0, costUsd: 0, durationMs: 1200.4, requests: 2, failures: 0, fallback: false, msFrom: 1, msTo: 2 },
    ], { sessionId: 's1' });
    await appendUsageEntries(ctx().ledgerFile, entries);
    await appendUsageEntries(ctx().ledgerFile, entries);
    const read = await readUsageEntries(ctx().ledgerFile);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({
      job: 'implement', backend: 'omp', provider: 'omlx', model: 'qwen', taskId: '001-task', projectId: 'p1',
      input: 10, output: 5, cacheRead: 1, durationMs: 1200, sessionId: 's1', requests: 2,
    });
  });

  it('reads a missing ledger as empty, skips broken lines and entries without tokens', async () => {
    expect(await readUsageEntries(path.join(root, 'none.jsonl'))).toEqual([]);
    const file = usageLedgerPath(root);
    await appendUsageEntries(file, ompUsageEntries(ctx(), [
      { model: 'empty', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, durationMs: 0, requests: 1, failures: 0, fallback: false },
    ]));
    expect(await readUsageEntries(file)).toEqual([]);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'not json\n{"at":"2026-01-01T00:00:00Z","model":"m","job":"nope","backend":"claude","input":3}\n{"model":1}\n');
    const read = await readUsageEntries(file);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ job: 'other', backend: 'claude', input: 3 });
  });

  it('turns a Claude Code result into one entry per model', () => {
    const result = {
      type: 'result', subtype: 'success', session_id: 'c1', is_error: false, duration_ms: 5000,
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.12 },
        'claude-haiku-4-5': { inputTokens: 5, outputTokens: 1, costUSD: 0.001 },
      },
    } as ClaudeResultMessage;
    const entries = claudeUsageEntries(ctx('plan'), result, 1000, new Date(9000));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ backend: 'claude', provider: 'anthropic', job: 'plan', cacheRead: 300, cacheWrite: 40, costUsd: 0.12, sessionId: 'c1', msFrom: 1000, msTo: 9000, durationMs: 0 });
    expect(claudeUsageEntries(ctx(), { ...result, modelUsage: { m: { inputTokens: 1 } } } as ClaudeResultMessage)[0].durationMs).toBe(5000);
  });
});

// Shaped like the real session files under .workbench/tasks/<spec>/omp-sessions
const T0 = Date.parse('2026-10-25T01:38:05.000Z');
function ompMessage(id: string, atMs: number, usage: { input: number; output: number; cacheRead?: number }, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'message', id, parentId: null, timestamp: new Date(atMs + 3000).toISOString(),
    message: {
      role: 'assistant', api: 'openai-completions', provider: 'omlx', model: 'Qwen3.8-Flash', stopReason: 'toolUse',
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
      timestamp: atMs, duration: 3000, completedAt: atMs + 3000, content: [{ type: 'text', text: 'x' }], ...extra,
    },
  });
}

async function writeTask(name: string): Promise<string> {
  const spec = path.join(root, '.workbench', 'tasks', name);
  await mkdir(path.join(spec, 'omp-sessions', 'sess-folder'), { recursive: true });
  await writeFile(path.join(spec, 'implementation_plan.json'), JSON.stringify({ feature: 'Build the thing' }));
  await writeFile(path.join(spec, 'claude_run.json'), JSON.stringify({
    version: 1, backend: 'omp', sessionId: 'omp-sess-1',
    phases: [
      { name: 'triage', startedAt: new Date(T0 - 60_000).toISOString() },
      { name: 'plan', startedAt: new Date(T0).toISOString() },
      { name: 'implement', startedAt: new Date(T0 + 10_000).toISOString() },
    ],
  }));
  const lines = [
    JSON.stringify({ type: 'title', v: 1, title: '' }),
    JSON.stringify({ type: 'session', version: 3, id: 'omp-sess-1', timestamp: new Date(T0).toISOString(), cwd: '/x' }),
    JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }),
    ompMessage('m1', T0 + 1000, { input: 100, output: 10 }),
    ompMessage('m2', T0 + 12_000, { input: 40, output: 20, cacheRead: 100 }),
    ompMessage('m3', T0 + 20_000, { input: 1, output: 1 }, { stopReason: 'error' }),
  ];
  await writeFile(path.join(spec, 'omp-sessions', 'sess.jsonl'), `${lines.join('\n')}\n`);
  // An advisor session next to it
  await writeFile(path.join(spec, 'omp-sessions', 'sess-folder', 'sess__advisor.jsonl'), `${[
    JSON.stringify({ type: 'session', id: 'adv-1' }),
    ompMessage('a1', T0 + 5000, { input: 7, output: 3 }, { provider: 'anthropic', model: 'claude-opus-5-5' }),
  ].join('\n')}\n`);
  return spec;
}

describe('usage backfill', () => {
  it('imports OMP sessions with phase jobs, advisor usage and durations', async () => {
    await writeTask('001-task');
    const result = await backfillUsage(root, { configDirs: [] });
    expect(result).toMatchObject({ added: 4, tasks: 1 });

    const entries = await readUsageEntries(usageLedgerPath(root));
    expect(entries.every((entry) => entry.source === 'backfill' && entry.taskId === '001-task')).toBe(true);
    expect(entries.map((entry) => `${entry.key}:${entry.job}`).sort()).toEqual([
      'omp:advisor:adv-1:a1:advisor',
      'omp:omp-sess-1:m1:plan',
      'omp:omp-sess-1:m2:implement',
      'omp:omp-sess-1:m3:implement',
    ]);
    const m2 = entries.find((entry) => entry.key === 'omp:omp-sess-1:m2')!;
    expect(m2).toMatchObject({ provider: 'omlx', input: 40, output: 20, cacheRead: 100, durationMs: 3000, backend: 'omp' });
    expect(entries.find((entry) => entry.key === 'omp:omp-sess-1:m3')?.failures).toBe(1);
  });

  it('is idempotent: a second run adds nothing and the totals stay the same', async () => {
    await writeTask('001-task');
    await backfillUsage(root, { configDirs: [] });
    const first = summarizeUsage(await readUsageEntries(usageLedgerPath(root)));
    const second = await backfillUsage(root, { configDirs: [] });
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(4);
    const again = summarizeUsage(await readUsageEntries(usageLedgerPath(root)));
    expect(again.totals).toEqual(first.totals);
    expect(again.entryCount).toBe(first.entryCount);
  });

  it('skips messages a live run already recorded for the same session', async () => {
    await writeTask('001-task');
    await appendUsageEntries(usageLedgerPath(root), ompUsageEntries(ctx(), [
      { provider: 'omlx', model: 'Qwen3.8-Flash', input: 140, output: 30, cacheRead: 100, cacheWrite: 0, costUsd: 0, durationMs: 6000, requests: 2, failures: 0, fallback: false, msFrom: T0 + 1000, msTo: T0 + 12_000 },
    ], { sessionId: 'omp-sess-1' }));
    const result = await backfillUsage(root, { configDirs: [] });
    // m1 and m2 are inside the live range; m3 (after it) and the advisor message are imported
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(2);
  });

  it('imports Claude Code transcripts of the tasks once per request', async () => {
    const spec = path.join(root, '.workbench', 'tasks', '002-claude');
    await mkdir(spec, { recursive: true });
    await writeFile(path.join(spec, 'claude_run.json'), JSON.stringify({
      version: 1, sessionId: 'claude-sess-1', worktreePath: path.join(root, 'wt'),
      phases: [{ name: 'plan', startedAt: '2026-10-20T10:00:00.000Z' }, { name: 'implement', startedAt: '2026-10-20T11:00:00.000Z' }],
    }));
    const configDir = path.join(root, 'claude-config');
    await mkdir(path.join(configDir, 'projects', 'some-project'), { recursive: true });
    const assistant = (requestId: string, timestamp: string, input: number) => JSON.stringify({
      type: 'assistant', requestId, timestamp,
      message: { id: `msg-${requestId}`, model: 'claude-sonnet-5-5', usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } },
    });
    await writeFile(path.join(configDir, 'projects', 'some-project', 'claude-sess-1.jsonl'), `${[
      assistant('r1', '2026-10-20T10:05:00.000Z', 100),
      // One API response is written as several records
      assistant('r1', '2026-10-20T10:05:00.000Z', 100),
      assistant('r2', '2026-10-20T11:05:00.000Z', 200),
      JSON.stringify({ type: 'user', message: {} }),
    ].join('\n')}\n`);

    const result = await backfillUsage(root, { configDirs: [configDir] });
    expect(result.added).toBe(2);
    const entries = await readUsageEntries(usageLedgerPath(root));
    expect(entries.map((entry) => entry.job).sort()).toEqual(['implement', 'plan']);
    expect(entries[0]).toMatchObject({ backend: 'claude', provider: 'anthropic', model: 'claude-sonnet-5-5', output: 10, cacheRead: 50, cacheWrite: 5 });
    expect(entries[0].costUsd).toBeGreaterThan(0);
    expect((await backfillUsage(root, { configDirs: [configDir] })).added).toBe(0);
  });

  it('picks the phase that was running', () => {
    const phases = [{ name: 'plan', startedMs: 100 }, { name: 'validate', startedMs: 200 }];
    expect(jobAt(phases, 50)).toBe('implement');
    expect(jobAt(phases, 150)).toBe('plan');
    expect(jobAt(phases, 250)).toBe('validate');
  });
});
