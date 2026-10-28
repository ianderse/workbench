import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import type { ClaudeProcessHandle } from '../../claude-code/process';
import type { ClaudeResultMessage } from '../../claude-code/stream-types';
import type { OmpRunOptions } from '../omp-process';
import { DEFAULT_OMP_BACKEND_SETTINGS } from '../../../shared/types/agent-backend';
import { OmpCooldownStore, ompFallbackCandidates } from '../omp-cooldown';
import { startWithOmpCooldownRecovery } from '../omp-provider-recovery';

const NOW = Date.parse('2026-10-27T14:44:24Z');
const delay = 245735000;
const error = `429 {"error":{"type":"rate_limit_error"}} retry-after-ms=${delay}`;
const primary = 'anthropic/claude-sonnet-5-5';
const fallback = 'openai-codex/gpt-6.1-sol';
const failed = (model = primary, text = error): ClaudeResultMessage => ({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'same-session', errors: [text], omp_errors: [{ text, model, fallback: false }], total_cost_usd: 0.2, num_turns: 1 });
const success: ClaudeResultMessage = { type: 'result', subtype: 'success', is_error: false, session_id: 'same-session', result: 'Continued successfully', total_cost_usd: 0.3, num_turns: 2 };
const outcome = (result: ClaudeResultMessage) => ({ result, exitCode: 0, signal: null, results: [result], resultOrigins: [] as [], unread: [], stderr: '', aborted: false, timedOut: false });
const handle = (result: ClaudeResultMessage): ClaudeProcessHandle => ({ child: {} as ChildProcess, done: Promise.resolve(outcome(result)), stop: vi.fn(), send: vi.fn(() => false as const) });
let root: string;
let store: OmpCooldownStore;
const policy = { roles: { default: primary }, chains: { 'anthropic/*': [fallback] } };
const options = (patch: Partial<OmpRunOptions> = {}): OmpRunOptions => ({ settings: DEFAULT_OMP_BACKEND_SETTINGS, cwd: root, prompt: 'Continue the task', model: primary, tools: [], session: { dir: root }, ...patch });
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'omp-cooldown-')); store = new OmpCooldownStore(path.join(root, 'cooldowns.json')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const deps = () => ({ store, policy, now: () => NOW });

describe('provider cooldown recovery', () => {
  it('switches immediately after one long-cooldown failure and resumes the session with preserved costs', async () => {
    const spawn = vi.fn<Parameters<typeof startWithOmpCooldownRecovery>[1]>().mockResolvedValueOnce(handle(failed())).mockResolvedValueOnce(handle(success));
    const notices: unknown[] = [];
    const run = await startWithOmpCooldownRecovery(options({ onMessage: (message) => notices.push(message) }), spawn, deps());
    const result = (await run.done).result!;
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ model: fallback, session: { resume: 'same-session' } });
    expect(result).toMatchObject({ is_error: false, total_cost_usd: 0.5, num_turns: 3 });
    expect(notices).toContainEqual(expect.objectContaining({ text: expect.stringContaining('switching immediately') }));
    expect((await store.active(NOW)).anthropic.resetAt).toBe(new Date(NOW + delay).toISOString());
  });

  it('re-acknowledges the same resumed identity before a cooldown fallback and propagates acknowledgment failure', async () => {
    const acknowledged: string[] = [];
    const onSessionReady = vi.fn(async (sessionId: string) => {
      acknowledged.push(sessionId);
      if (acknowledged.length === 2) throw new Error('replacement journal unavailable');
    });
    const spawn = vi.fn<Parameters<typeof startWithOmpCooldownRecovery>[1]>(async (runOptions) => {
      await runOptions.onSessionReady?.(runOptions.session?.resume ?? 'same-session');
      return acknowledged.length === 1 ? handle(failed()) : handle(success);
    });
    const run = await startWithOmpCooldownRecovery(options({ onSessionReady }), spawn, deps());
    await expect(run.done).rejects.toThrow('replacement journal unavailable');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0].session?.resume).toBe('same-session');
    expect(acknowledged).toEqual(['same-session', 'same-session']);
  });

  it('persists the provider hold across restarts and skips all Anthropic models until the advertised deadline', async () => {
    await store.record('anthropic', new Date(NOW + delay).toISOString());
    store = new OmpCooldownStore(path.join(root, 'cooldowns.json'));
    const spawn = vi.fn(async (_options: OmpRunOptions) => handle(success));
    const run = await startWithOmpCooldownRecovery(options({ model: 'anthropic/claude-opus-5-5' }), spawn, deps());
    await run.done;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].model).toBe(fallback);
    const afterReset = vi.fn(async (_options: OmpRunOptions) => handle(success));
    await (await startWithOmpCooldownRecovery(options(), afterReset, { ...deps(), now: () => NOW + delay + 1 })).done;
    expect(afterReset.mock.calls[0][0].model).toBe(primary);
  });

  it('holds without spawning if all configured providers are cooling down', async () => {
    for (const provider of ['anthropic', 'openai-codex']) await store.record(provider, new Date(NOW + delay).toISOString());
    const spawn = vi.fn(async (_options: OmpRunOptions) => handle(success));
    const run = await startWithOmpCooldownRecovery(options(), spawn, deps());
    expect((await run.done).result?.omp_cooldown).toMatchObject({ provider: 'anthropic', resetAt: new Date(NOW + delay).toISOString() });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rechecks at the earliest usable fallback reset rather than the primary weekly reset', async () => {
    await store.record('anthropic', new Date(NOW + delay).toISOString());
    const earlier = new Date(NOW + 3 * 60 * 60_000).toISOString();
    await store.record('openai-codex', earlier);
    const spawn = vi.fn(async (_options: OmpRunOptions) => handle(success));
    const run = await startWithOmpCooldownRecovery(options(), spawn, deps());
    expect((await run.done).result?.omp_cooldown?.resetAt).toBe(earlier);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not loop when a fallback is exhausted, and does not invent an unconfigured fallback', async () => {
    const spawn = vi.fn<Parameters<typeof startWithOmpCooldownRecovery>[1]>().mockResolvedValueOnce(handle(failed())).mockResolvedValueOnce(handle(failed(fallback)));
    const run = await startWithOmpCooldownRecovery(options(), spawn, deps());
    expect((await run.done).result?.omp_cooldown?.provider).toBe('openai-codex');
    expect(spawn).toHaveBeenCalledTimes(2);
    const noFallback = vi.fn(async (_options: OmpRunOptions) => handle(success));
    const held = await startWithOmpCooldownRecovery(options(), noFallback, { ...deps(), policy: { roles: policy.roles, chains: {} } });
    expect((await held.done).result?.omp_cooldown?.provider).toBe('anthropic');
    expect(noFallback).not.toHaveBeenCalled();
  });

  it.each(['429 Too Many Requests retry-after-ms=1000', 'connect ECONNREFUSED 127.0.0.1:8000', '401 Unauthorized'])('keeps normal failure behavior for %s', async (text) => {
    const spawn = vi.fn(async (_options: OmpRunOptions) => handle(failed(primary, text)));
    await (await startWithOmpCooldownRecovery(options(), spawn, deps())).done;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await store.active(NOW)).toEqual({});
  });

  it('keeps local workers running, filters known exhausted native fallbacks and replaces a blocked advisor', async () => {
    await store.record('anthropic', new Date(NOW + delay).toISOString());
    const spawn = vi.fn(async (_options: OmpRunOptions) => handle(success));
    const run = await startWithOmpCooldownRecovery(options({ model: 'omlx/local', settings: { ...DEFAULT_OMP_BACKEND_SETTINGS, advisor: 'on', advisorModel: primary } }), spawn, { ...deps(), policy: { roles: {}, chains: { default: [primary, fallback], advisor: [fallback] } } });
    await run.done;
    expect(spawn.mock.calls[0][0]).toMatchObject({ model: 'omlx/local', settings: { advisor: 'on', advisorModel: fallback }, cooldownFallbackChains: { default: [fallback] } });
  });

  it('serializes concurrent provider updates and never shortens a known cooldown', async () => {
    await Promise.all([store.record('anthropic', new Date(NOW + delay).toISOString()), store.record('openai-codex', new Date(NOW + delay).toISOString()), store.record('anthropic', new Date(NOW + 1000).toISOString())]);
    expect(Object.keys(await store.active(NOW)).sort()).toEqual(['anthropic', 'openai-codex']);
    expect((await store.active(NOW)).anthropic.resetAt).toBe(new Date(NOW + delay).toISOString());
  });
});

it('respects exact/model-prefix/provider/role chains, expands wildcards and preserves explicit thinking', () => {
  expect(ompFallbackCandidates('vendor/model', 'plan', {
    'vendor/model': ['provider/exact:medium'], 'vendor/mo*': ['ignored/model'], 'vendor/*': ['other/*'], plan: ['@alternate', 'provider/exact:medium'],
  }, { alternate: 'omlx/local' })).toEqual([
    { model: 'provider/exact', thinking: 'medium' }, { model: 'other/model' }, { model: 'omlx/local' },
  ]);
});
