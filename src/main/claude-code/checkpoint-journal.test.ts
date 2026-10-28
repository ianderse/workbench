import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { beginCheckpoint, completeCheckpoint, failCheckpoint } from './checkpoint-journal';

let root: string;
const metadata = { model: 'configured/reviewer', input: { plan: 'Plan', humanRevision: 4, diff: 'full-diff-sha' } };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-checkpoint-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('checkpoint journal', () => {
  it('publishes pending before work, caches only a completed matching call and preserves the original attempt artifact', async () => {
    const start = await beginCheckpoint<{ findings: string[] }>(root, 'plan-1', metadata);
    expect(start).toMatchObject({ execute: true, cached: false, record: { status: 'pending', attempt: 1, metadata } });
    expect(JSON.parse(await fs.readFile(start.record.path, 'utf8')).status).toBe('pending');
    const pending = path.join(path.dirname(start.record.path), 'attempt-1.pending.json');
    const original = await fs.readFile(pending, 'utf8');
    await completeCheckpoint(root, 'plan-1', 1, { findings: ['A real issue remains open'] });
    const again = await beginCheckpoint(root, 'plan-1', { input: { humanRevision: 4, diff: 'full-diff-sha', plan: 'Plan' }, model: 'configured/reviewer' });
    expect(again).toMatchObject({ execute: false, cached: true, record: { status: 'completed', attempt: 1, result: { findings: ['A real issue remains open'] } } });
    expect(await fs.readFile(pending, 'utf8')).toBe(original);
    await expect(completeCheckpoint(root, 'plan-1', 1, { findings: [] })).rejects.toThrow('cannot be replaced');
    await expect(beginCheckpoint(root, 'plan-1', { ...metadata, model: 'different/model' })).rejects.toThrow('inputs');
  });

  it('allows only one live execution and never treats a still-pending concurrent request as cached success', async () => {
    const attempts = await Promise.all([beginCheckpoint(root, 'same', metadata), beginCheckpoint(root, 'same', metadata)]);
    expect(attempts.filter((attempt) => attempt.execute)).toHaveLength(1);
    expect(attempts.find((attempt) => !attempt.execute)).toMatchObject({ cached: false, record: { status: 'pending' } });
  });

  it('bounds failures and retains every prior attempt instead of returning them as passed advice', async () => {
    const start = await beginCheckpoint(root, 'failed', metadata);
    await failCheckpoint(root, 'failed', start.record.attempt, 'model unavailable');
    const retry = await beginCheckpoint(root, 'failed', metadata);
    expect(retry).toMatchObject({ execute: true, cached: false, record: { attempt: 2, history: [{ attempt: 1, status: 'failed' }] } });
    await failCheckpoint(root, 'failed', 2, 'still unavailable');
    expect(await beginCheckpoint(root, 'failed', metadata)).toMatchObject({ execute: false, cached: false, record: { attempt: 2, status: 'failed' } });
    expect(await fs.readFile(path.join(path.dirname(start.record.path), 'attempt-1.failed.json'), 'utf8')).toContain('model unavailable');
  });

  it('recovers an interrupted pending call after process restart without an unbounded new attempt budget', async () => {
    const start = await beginCheckpoint(root, 'interrupted', metadata);
    vi.resetModules();
    const restarted = await import('./checkpoint-journal');
    const retry = await restarted.beginCheckpoint(root, 'interrupted', metadata);
    expect(retry).toMatchObject({ execute: true, record: { attempt: 2, history: [{ attempt: 1, status: 'failed' }] } });
    vi.resetModules();
    const restartedAgain = await import('./checkpoint-journal');
    const exhausted = await restartedAgain.beginCheckpoint(root, 'interrupted', metadata);
    expect(exhausted).toMatchObject({ execute: false, cached: false, record: { attempt: 2, status: 'failed' } });
    expect(await fs.readFile(path.join(path.dirname(start.record.path), 'attempt-1.pending.json'), 'utf8')).toContain('pending');
  });

  it('recovers a completed terminal artifact if the process stopped before updating the current pointer', async () => {
    const start = await beginCheckpoint(root, 'pointer', metadata);
    await completeCheckpoint(root, 'pointer', 1, { status: 'failed', issue: 'The checker reported a real failure' });
    await fs.writeFile(start.record.path, JSON.stringify(start.record));
    vi.resetModules();
    const restarted = await import('./checkpoint-journal');
    expect(await restarted.beginCheckpoint(root, 'pointer', metadata)).toMatchObject({ execute: false, cached: true, record: { status: 'completed', result: { status: 'failed' } } });
  });

  it('recovers an attempt artifact even if the index never published, and fails closed on a missing terminal artifact', async () => {
    const start = await beginCheckpoint(root, 'orphan', metadata);
    await fs.unlink(start.record.path);
    vi.resetModules();
    const restarted = await import('./checkpoint-journal');
    expect(await restarted.beginCheckpoint(root, 'orphan', metadata)).toMatchObject({ execute: true, record: { attempt: 2 } });
    await restarted.completeCheckpoint(root, 'orphan', 2, { ready: true });
    await fs.unlink(path.join(path.dirname(start.record.path), 'attempt-2.completed.json'));
    await expect(restarted.beginCheckpoint(root, 'orphan', metadata)).rejects.toThrow('terminal artifact is missing');
  });

  it.each([{ version: 0 }, { status: 'invented' }, { attempt: -1 }, { history: null }, { metadataDigest: 'not-a-digest' }])('rejects malformed journal records instead of returning a cache hit: %j', async (malformed) => {
    const start = await beginCheckpoint(root, 'malformed', metadata);
    await fs.writeFile(start.record.path, JSON.stringify({ ...start.record, ...malformed }));
    await expect(beginCheckpoint(root, 'malformed', metadata)).rejects.toThrow('Malformed checkpoint');
  });

  it('serializes optional JSON metadata fields consistently without sharing mutable caller data', async () => {
    const input = { model: 'configured/reviewer', optional: undefined, nested: { original: true } };
    const start = await beginCheckpoint(root, 'optional', input);
    input.nested.original = false;
    expect(start.record.metadata).toEqual({ model: 'configured/reviewer', nested: { original: true } });
    await completeCheckpoint(root, 'optional', 1, null);
    expect(await beginCheckpoint(root, 'optional', { model: 'configured/reviewer', nested: { original: true } })).toMatchObject({ cached: true, record: { result: null } });
  });
});
