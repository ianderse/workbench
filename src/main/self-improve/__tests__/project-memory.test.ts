import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import type { MemoryContent, ProjectMemory } from '../../../shared/types/project-memory';
import { claimMemoryReviewNotice, reviewAutomaticMemories, listProjectMemories, MEMORY_CONTEXT_TOKEN_LIMIT, mutateProjectMemory, readMemoryContexts, recallProjectMemory, saveMemoryContext } from '../project-memory';

const fault = vi.hoisted(() => ({ rename: false }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.rename) { fault.rename = false; throw new Error('simulated interruption before publication'); }
    return actual.rename(...args);
  } };
});

let root: string;
let dir: string;
const project = 'project-a';
const content = (title = 'Vitest worker failure'): MemoryContent => ({ kind: 'lesson', title, body: 'Vitest worker failures need the observed failing test and output before retrying.', source: { type: 'task', reference: '001-tests', evidence: 'Observed worker exit in task 001. This is an investigation note, not proof of a fix.' } });
const propose = (requestId: string, value = content()) => mutateProjectMemory(dir, project, { action: 'propose', requestId, content: value });
const accept = (entry: ProjectMemory) => mutateProjectMemory(dir, project, { action: 'accept', id: entry.id, expectedRevision: entry.revision });
const recall = (query = 'Vitest worker failure', extra = {}) => recallProjectMemory({ dir, projectId: project, taskId: '002-retry', phase: 'implement', query, ...extra });

beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'wb-project-memory-')); dir = path.join(root, 'project', '.workbench', 'compeng'); fault.rename = false; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('project memory lifecycle and provenance', () => {
  it('keeps proposals out of recall and preserves exact source evidence on acceptance', async () => {
    const draft = await propose('failure');
    expect((await recall()).items).toEqual([]);
    const active = await accept(draft);
    expect(active.verification).toBe('user-confirmed');
    expect(active.source).toEqual(content().source);
    expect(active.history[0].status).toBe('proposed');
    expect((await recall()).items[0]).toMatchObject({ id: active.id, revision: 2, source: content().source });
  });

  it('replays a retry after reloading the module without creating another record', async () => {
    const first = await propose('stable-id');
    vi.resetModules();
    const fresh = await import('../project-memory');
    expect((await fresh.mutateProjectMemory(dir, project, { action: 'propose', requestId: 'stable-id', content: content() })).id).toBe(first.id);
    await expect(propose('stable-id', content('Different claim'))).rejects.toThrow('different content');
    expect(await fresh.listProjectMemories(dir, project)).toHaveLength(1);
  });

  it('deduplicates parallel submissions and serializes competing edits', async () => {
    const copies = await Promise.all(Array.from({ length: 12 }, (_, i) => propose(`worker-${i}`)));
    expect(new Set(copies.map((entry) => entry.id)).size).toBe(1);
    const active = await accept(copies[0]);
    const writes = await Promise.allSettled(['First correction', 'Second correction'].map((title) => mutateProjectMemory(dir, project, { action: 'revise', id: active.id, expectedRevision: active.revision, content: content(title) })));
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const [entry] = await listProjectMemories(dir, project);
    expect(entry.history).toHaveLength(2);
    expect(entry.status).toBe('proposed');
    expect((await recall()).items).toHaveLength(0);
  });

  it('coalesces repeated task claims across sources without changing the accepted evidence', async () => {
    const active = await accept(await propose('first-task'));
    const repeated = { ...content(), source: { ...content().source, reference: '002-later-task', commit: 'b'.repeat(40), evidence: 'A later task repeated the same claim.' } };
    const copies = await Promise.all(Array.from({ length: 8 }, (_, i) => propose(`later-${i}`, repeated)));
    expect(copies.every((entry) => entry.id === active.id)).toBe(true);
    expect(await listProjectMemories(dir, project)).toEqual([active]);
    vi.resetModules();
    const fresh = await import('../project-memory');
    expect(await fresh.mutateProjectMemory(dir, project, { action: 'propose', requestId: 'later-0', content: repeated })).toEqual(active);
    await expect(propose('later-0', { ...repeated, body: 'A different claim.' })).rejects.toThrow('different content');
  });

  it('coalesces recategorized claims while preserving the original category and evidence', async () => {
    const active = await accept(await propose('original-lesson'));
    const copy = await propose('another-category', { ...content(), kind: 'procedure', source: { ...content().source, reference: '126-acceptance', evidence: 'A different task repeated this.' } });
    expect(copy).toEqual(active);
    expect(await listProjectMemories(dir, project)).toEqual([active]);
  });

  it('keeps distinct claims with different titles even when their short bodies match', async () => {
    await propose('first');
    await propose('second', content('Different investigation scope'));
    expect(await listProjectMemories(dir, project)).toHaveLength(2);
  });

  it('supersedes atomically only on acceptance, preserving both histories and rejecting competing replacements', async () => {
    const old = await accept(await propose('old'));
    const replacement = await mutateProjectMemory(dir, project, { action: 'propose', requestId: 'replacement', content: content('Vitest revised decision'), supersedes: old.id });
    const competing = await mutateProjectMemory(dir, project, { action: 'propose', requestId: 'competing', content: content('Vitest competing decision'), supersedes: old.id });
    expect((await recall()).items.map((item) => item.id)).toEqual([old.id]);
    await accept(replacement);
    await expect(accept(competing)).rejects.toThrow('conflict');
    const entries = await listProjectMemories(dir, project);
    expect(entries.find((item) => item.id === old.id)).toMatchObject({ status: 'obsolete', revision: 3 });
    expect((await recall()).items.map((item) => item.id)).toEqual([replacement.id]);
  });

  it('removes future recall without rewriting historical task receipts', async () => {
    const active = await accept(await propose('accepted'));
    const before = await recall();
    const taskDir = path.join(root, 'task');
    await saveMemoryContext(taskDir, before);
    await mutateProjectMemory(dir, project, { action: 'delete', id: active.id, expectedRevision: active.revision });
    expect((await recall()).items).toEqual([]);
    expect((await readMemoryContexts(taskDir, project, '002-retry'))[0]).toEqual(before);
    await expect(readMemoryContexts(taskDir, 'other-project', '002-retry')).rejects.toThrow('another task or project');
  });

  it('can correct and re-accept a replacement without superseding its predecessor twice', async () => {
    const old = await accept(await propose('old'));
    const replacement = await mutateProjectMemory(dir, project, { action: 'propose', requestId: 'new', content: content('Vitest replacement'), supersedes: old.id });
    const active = await accept(replacement);
    const corrected = await mutateProjectMemory(dir, project, { action: 'revise', id: active.id, expectedRevision: active.revision, content: { ...content('Vitest replacement'), body: 'Inspect the observed worker stderr and exit code.' } });
    expect((await accept(corrected)).status).toBe('active');
    const entries = await listProjectMemories(dir, project);
    expect(entries.find((entry) => entry.id === old.id)?.revision).toBe(3);
    expect((await recall()).items.map((item) => item.id)).toEqual([active.id]);
  });

  it('rejects foreign project ids and never rewrites corrupt storage', async () => {
    await propose('first');
    await expect(listProjectMemories(dir, 'project-b')).rejects.toThrow('another project');
    expect((await recall('unrelated earnings announcement')).items).toEqual([]);
    const ledger = path.join(dir, 'records', 'project-memory.json');
    await writeFile(ledger, '{damaged');
    await expect(propose('second')).rejects.toThrow();
    expect(await readFile(ledger, 'utf8')).toBe('{damaged');
  });

  it('leaves the prior durable state intact on interruption, then retries the same request', async () => {
    await propose('first');
    const ledger = path.join(dir, 'records', 'project-memory.json');
    const before = await readFile(ledger, 'utf8');
    fault.rename = true;
    await expect(propose('second', content('Second lesson'))).rejects.toThrow('simulated interruption');
    expect(await readFile(ledger, 'utf8')).toBe(before);
    expect((await readdir(path.dirname(ledger))).filter((file) => file.endsWith('.tmp') || file.endsWith('.lock'))).toEqual([]);
    await propose('second', content('Second lesson'));
    expect(await listProjectMemories(dir, project)).toHaveLength(2);
  });

  it('handles prototype-shaped retry ids as data', async () => {
    const first = await propose('__proto__');
    expect((await propose('__proto__')).id).toBe(first.id);
    expect(await listProjectMemories(dir, project)).toHaveLength(1);
  });

  it('keeps conflicting same-title claims proposed until their replacement scope is explicit', async () => {
    await accept(await propose('original'));
    const conflicting = await propose('conflict', { ...content(), body: 'A contradictory claim with different evidence.' });
    await expect(accept(conflicting)).rejects.toThrow('clarify the scope');
    expect((await listProjectMemories(dir, project)).find((entry) => entry.id === conflicting.id)?.status).toBe('proposed');
  });
});

describe('bounded recall and legacy compatibility', () => {
  it('supplies a labeled excerpt of a long relevant memory instead of dropping it', async () => {
    await accept(await propose('long', { ...content(), body: 'Vitest worker ' + 'observed evidence '.repeat(350) }));
    const packet = await recall();
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0].truncated).toBe(true);
    expect(packet.estimatedTokens).toBeLessThanOrEqual(MEMORY_CONTEXT_TOKEN_LIMIT);
  });
  it('keeps the full UTF-8 prompt within the token estimate ceiling and deterministic item cap', async () => {
    for (let i = 0; i < 12; i++) await accept(await propose(`note-${i}`, { ...content(`Vitest worker ${i}`), body: 'Vitest worker ' + '検証済み '.repeat(70) }));
    const packet = await recall();
    expect(packet.items.length).toBeGreaterThan(0);
    expect(packet.items.length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(packet.prompt, 'utf8')).toBeLessThanOrEqual(MEMORY_CONTEXT_TOKEN_LIMIT * 3);
    expect(packet.estimatedTokens).toBeLessThanOrEqual(MEMORY_CONTEXT_TOKEN_LIMIT);
    expect((await recall()).prompt).toBe(packet.prompt);
  });

  it('reads relevant legacy notes without altering originals or following symlinks', async () => {
    await mkdir(dir, { recursive: true });
    const index = '- [Vitest worker notes](worker.md) — Vitest worker output\n- [Vitest outside](outside.md) — Vitest\n';
    const note = '---\nname: worker\n---\nRead the Vitest worker output before retrying.\n';
    await writeFile(path.join(dir, 'MEMORY.md'), index);
    await writeFile(path.join(dir, 'worker.md'), note);
    await writeFile(path.join(root, 'secret.md'), 'Vitest OUTSIDE_SECRET');
    await symlink(path.join(root, 'secret.md'), path.join(dir, 'outside.md'));
    const packet = await recall();
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0].verification).toBe('legacy-unverified');
    expect(packet.prompt).not.toContain('OUTSIDE_SECRET');
    expect(await readFile(path.join(dir, 'MEMORY.md'), 'utf8')).toBe(index);
    expect(await readFile(path.join(dir, 'worker.md'), 'utf8')).toBe(note);
  });
});

it('serializes real independent worker processes without losing entries', async () => {
  const source = await readFile(path.join(process.cwd(), 'src/main/self-improve/project-memory.ts'), 'utf8');
  await writeFile(path.join(root, 'memory.cjs'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
  const events = await readFile(path.join(process.cwd(), 'src/main/self-improve/memory-events.ts'), 'utf8');
  await writeFile(path.join(root, 'memory-events.js'), ts.transpileModule(events, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
  await symlink(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const worker = path.join(root, 'worker.cjs');
  await writeFile(worker, `const {mutateProjectMemory}=require('./memory.cjs');
const [dir,worker]=process.argv.slice(2);
(async()=>{for(let i=0;i<4;i++) await mutateProjectMemory(dir,'project-a',{action:'propose',requestId:worker+'-'+i,content:{kind:'lesson',title:worker+' '+i,body:'Independent worker observation',source:{type:'task',reference:worker,evidence:'Observed in worker '+worker}}});})().catch(e=>{process.stderr.write(e.stack);process.exitCode=1});`);
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => promisify(execFile)(process.execPath, [worker, dir, id])));
  expect(await listProjectMemories(dir, project)).toHaveLength(16);
}, 20_000);

it('automatically retains source-backed lessons while keeping procedures and preferences provisional', async () => {
  const lesson = await propose('lesson');
  const procedure = await propose('procedure', { ...content('Reusable Vitest procedure'), kind: 'procedure' });
  const preference = await propose('preference', { ...content('Preferred Vitest output'), kind: 'preference' });
  for (const entry of [lesson, procedure, preference]) await reviewAutomaticMemories(dir, project, [{ id: entry.id, expectedRevision: entry.revision, proof: { file: 'docs/testing.md', quote: entry.body, commit: 'a'.repeat(40) } }]);
  const entries = await listProjectMemories(dir, project);
  expect(entries[0]).toMatchObject({ status: 'active', verification: 'source-backed' });
  expect(entries[1]).toMatchObject({ status: 'proposed', reviewReason: 'procedure' });
  expect(entries[2]).toMatchObject({ status: 'proposed', reviewReason: 'preference' });
});

it('does not automatically retain implementation trivia just because it has a checked quote', async () => {
  const entry = await propose('code-fact', { ...content('PRNG Algorithm Details'), body: 'The PRNG uses sfc32 with four state words.' });
  await reviewAutomaticMemories(dir, project, [{ id: entry.id, expectedRevision: entry.revision, proof: { file: 'docs/design.md', quote: entry.body, commit: 'a'.repeat(40) } }]);
  expect((await listProjectMemories(dir, project))[0]).toMatchObject({ status: 'proposed', verification: 'unverified', reviewReason: 'unverified' });
});

it('flags disputed recall and resolves conflicts atomically against current revisions', async () => {
  const old = await accept(await propose('old'));
  const draft = await propose('new', { ...content('Vitest output changed'), body: 'Inspect a different worker output stream.' });
  await reviewAutomaticMemories(dir, project, [{ id: draft.id, expectedRevision: draft.revision, conflictsWith: [old.id], proof: { commit: 'a'.repeat(40), file: 'docs/testing.md', quote: draft.body } }]);
  const pending = (await listProjectMemories(dir, project)).find((entry) => entry.id === draft.id)!;
  expect(pending).toMatchObject({ status: 'proposed', reviewReason: 'conflict', conflictsWith: [old.id] });
  expect((await recall()).items[0].disputedBy).toEqual([draft.id]);
  await expect(mutateProjectMemory(dir, project, { action: 'resolve', id: pending.id, expectedRevision: pending.revision, conflicts: [{ id: old.id, revision: 1 }] })).rejects.toThrow('changed');
  await mutateProjectMemory(dir, project, { action: 'resolve', id: pending.id, expectedRevision: pending.revision, conflicts: [{ id: old.id, revision: old.revision }] });
  const entries = await listProjectMemories(dir, project);
  expect(entries.find((entry) => entry.id === old.id)?.status).toBe('obsolete');
  expect(entries.find((entry) => entry.id === draft.id)?.verification).toBe('user-confirmed');
});

it('retires old automatic duplicate proposals instead of flagging the accepted claim as disputed', async () => {
  const active = await accept(await propose('original'));
  // Simulate an older ledger that allowed a second task to duplicate an accepted memory.
  const file = path.join(dir, 'records/project-memory.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  const duplicate = { ...content(), kind: 'procedure', id: 'old-duplicate', projectId: project, revision: 2, status: 'proposed', verification: 'unverified', at: new Date().toISOString(), history: [], reviewReason: 'conflict', conflictsWith: [active.id] };
  ledger.entries.push(duplicate);
  ledger.requests['capture:old-job:0'] = { fingerprint: 'a'.repeat(64), id: duplicate.id };
  await writeFile(file, JSON.stringify(ledger));
  await reviewAutomaticMemories(dir, project, [{ id: duplicate.id, expectedRevision: 2 }]);
  const entries = await listProjectMemories(dir, project);
  expect(entries.find((entry) => entry.id === active.id)).toEqual(active);
  expect(entries.find((entry) => entry.id === duplicate.id)).toMatchObject({ status: 'obsolete', revision: 3, history: [{ status: 'proposed', reviewReason: 'conflict' }] });
  expect((await recall()).items[0].disputedBy).toBeUndefined();
  expect(await claimMemoryReviewNotice(dir, project)).toEqual([]);
  await reviewAutomaticMemories(dir, project, [{ id: duplicate.id, expectedRevision: 3 }]);
  expect(await listProjectMemories(dir, project)).toEqual(entries);
});

it('durably batches review notices once per revision and defers running task proposals', async () => {
  const entry = await propose('notice');
  expect(await claimMemoryReviewNotice(dir, project, [])).toEqual([]);
  expect(await claimMemoryReviewNotice(dir, project, ['001-tests'])).toHaveLength(1);
  expect(await claimMemoryReviewNotice(dir, project, ['001-tests'])).toEqual([]);
  await mutateProjectMemory(dir, project, { action: 'revise', id: entry.id, expectedRevision: entry.revision, content: content('Newly revised Vitest observation') });
  expect(await claimMemoryReviewNotice(dir, project, ['001-tests'])).toHaveLength(1);
});
