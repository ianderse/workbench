import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { closeTaskToolsServer } from '../../insights/task-tools-server';
import { openTaskMemoryTools } from '../task-memory';
import { listProjectMemories, mutateProjectMemory } from '../project-memory';
import * as memoryLedger from '../project-memory';

vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const transport = vi.hoisted(() => ({ route: 'direct' }));
vi.mock('../../insights/claude-code-runner', () => ({
  getTaskToolsRoute: () => transport.route,
  taskToolsEntry: async (server: unknown) => server,
}));

let root: string;
let dir: string;
let close: (() => void) | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wb-memory-tool-'));
  dir = path.join(root, '.workbench', 'compeng');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, '.workbench', 'settings.json'), JSON.stringify({ selfImprove: true }));
  transport.route = 'direct';
});
afterEach(async () => { close?.(); close = undefined; await closeTaskToolsServer(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function startTask(specId = '001-failure') {
  const session = (await openTaskMemoryTools({ dir, projectId: 'project-a', specId, tempDir: root, omp: true }))!;
  close = session.close;
  if (session.server.type !== 'http') throw new Error('Expected HTTP');
  const server = session.server;
  const call = async (args: Record<string, unknown>) => {
    const response = await fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_project_memory', arguments: args } }) });
    return (await response.json()).result;
  };
  return { session, call };
}
const valueOf = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);
const taskNoteFiles = () => readdir(path.join(dir, 'records', 'task-notes'));

describe('memory capture real HTTP transport', () => {
  it('exposes only proposal capture, binds task identity, persists retries once, and revokes its token', async () => {
    const session = (await openTaskMemoryTools({ dir, projectId: 'project-a', specId: '001-failure', tempDir: root, omp: true }))!;
    close = session.close;
    if (session.server.type !== 'http') throw new Error('Expected HTTP');
    const server = session.server;
    const call = async (name: string, args: unknown, authorized = true) => {
      const result = await fetch(server.url, { method: 'POST', headers: { ...(authorized ? server.headers : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: name, params: args }) });
      return { status: result.status, body: await result.json() };
    };
    expect((await call('tools/list', {})).body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['propose_project_memory']);
    expect((await call('tools/list', {}, false)).status).toBe(401);
    const args = { requestId: 'observed-failure', kind: 'lesson', title: 'Vitest worker output', body: 'Inspect the worker output.', evidence: 'Observed an exit. No fix verified.' };
    const first = await call('tools/call', { name: 'propose_project_memory', arguments: args });
    expect(first.body.result.isError).not.toBe(true);
    await call('tools/call', { name: 'propose_project_memory', arguments: args });
    const entries = await listProjectMemories(dir, 'project-a');
    expect(entries).toHaveLength(0);
    expect(valueOf(first.body.result)).toMatchObject({ status: 'task-local', verification: 'unverified' });
    expect(await taskNoteFiles()).toHaveLength(1);
    const saved = JSON.parse(await readFile(path.join(dir, 'records', 'task-notes', (await taskNoteFiles())[0]), 'utf8'));
    expect(saved).toMatchObject({ taskId: '001-failure', projectId: 'project-a', route: 'task-local', content: { body: args.body, source: { reference: '001-failure' } } });
    expect((await call('tools/call', { name: 'accept', arguments: { id: valueOf(first.body.result).id } })).body.result.isError).toBe(true);
    close();
    expect((await call('tools/list', {})).status).toBe(401);
  });

  it('executes the generated OMP extension over the real server and honors a disabled project', async () => {
    const session = (await openTaskMemoryTools({ dir, projectId: 'project-a', specId: '001-failure', tempDir: root, omp: true }))!;
    close = session.close;
    const registered: Array<{ name: string; execute: (id: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
    const extension = await import(/* @vite-ignore */ pathToFileURL(session.extension!).href);
    extension.default({ registerTool: (tool: typeof registered[number]) => registered.push(tool) });
    expect(registered.map((tool) => tool.name)).toEqual(['propose_project_memory']);
    const args = { i: 'Preserving an observed lesson', requestId: 'fixture', kind: 'lesson', title: 'Fixture isolation', body: 'Isolate fixture state between tests.', evidence: 'Observed shared fixture state in this task.' };
    const result = await registered[0].execute('call-1', args);
    expect(JSON.parse(result.content[0].text).status).toBe('task-local');
    await writeFile(path.join(root, '.workbench', 'settings.json'), JSON.stringify({ selfImprove: false }));
    await expect(registered[0].execute('call-2', { ...args, requestId: 'another' })).rejects.toThrow('disabled');
    expect(await listProjectMemories(dir, 'project-a')).toHaveLength(0);
  });

  it('persists concurrent task-local retries once, survives reopening, and rejects changed content', async () => {
    let { call, session } = await startTask();
    const args = { requestId: 'routine', kind: 'lesson', title: 'Task result', body: 'Inspect the output before retrying.', evidence: 'Observed output.' };
    const results = await Promise.all(Array.from({ length: 4 }, () => call(args)));
    expect(new Set(results.map((result) => valueOf(result).id)).size).toBe(1);
    expect(results.every((result) => valueOf(result).status === 'task-local')).toBe(true);
    expect(await taskNoteFiles()).toHaveLength(1);
    session.close();
    ({ call, session } = await startTask());
    expect(valueOf(await call(args)).id).toBe(valueOf(results[0]).id);
    expect((await call({ ...args, body: 'Changed guidance.' })).isError).toBe(true);
    expect(await listProjectMemories(dir, 'project-a')).toEqual([]);
    expect(await taskNoteFiles()).toHaveLength(1);
  });

  it('routes useful exact documentation citations to the ledger without accepting them', async () => {
    const { call } = await startTask();
    const body = 'Use atomic publication because an interrupted write must preserve the last committed record.';
    const args = { requestId: 'citation', kind: 'decision', title: 'Atomic publication', body, evidence: 'Design rationale; no runtime validation claimed.', file: 'docs/decisions.md', quote: body };
    const result = valueOf(await call(args));
    expect(result).toMatchObject({ status: 'proposed', verification: 'unverified' });
    const entries = await listProjectMemories(dir, 'project-a');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: result.id, status: 'proposed', verification: 'unverified', source: { type: 'task', reference: '001-failure', file: 'docs/decisions.md', quote: body } });
    expect(valueOf(await call(args)).id).toBe(result.id);
    expect(await listProjectMemories(dir, 'project-a')).toHaveLength(1);
  });

  it('keeps non-document citations and implementation recaps task-local', async () => {
    const { call } = await startTask();
    for (const [requestId, body, file] of [
      ['code', 'Use atomic publication to protect an interrupted record.', 'src/record.ts'],
      ['recap', 'Removed unused imports and verified the output.', 'docs/results.md'],
    ]) {
      expect(valueOf(await call({ requestId, kind: 'lesson', title: requestId, body, file, quote: body, evidence: 'Task report.' })).status).toBe('task-local');
    }
    expect(await listProjectMemories(dir, 'project-a')).toEqual([]);
    expect(await taskNoteFiles()).toHaveLength(2);
  });

  it('keeps genuine active replacements and same-title conflicts available for a decision', async () => {
    const existing = await mutateProjectMemory(dir, 'project-a', { action: 'propose', requestId: 'owner', content: { kind: 'decision', title: 'Durable ordering', body: 'Preserve the original order.', source: { type: 'user', reference: 'Owner', evidence: 'Explicit standing instruction.' } } });
    const active = await mutateProjectMemory(dir, 'project-a', { action: 'accept', id: existing.id, expectedRevision: existing.revision });
    const { call } = await startTask();
    const args = { requestId: 'replacement', kind: 'decision', title: 'New ordering', body: 'Use a different order for this operation.', evidence: 'Observed a concrete contradiction.', supersedes: active.id };
    expect(valueOf(await call(args))).toMatchObject({ status: 'proposed', verification: 'unverified' });
    expect(valueOf(await call({ ...args, requestId: 'same-title', title: active.title, supersedes: undefined }))).toMatchObject({ status: 'proposed', verification: 'unverified' });
    const entries = await listProjectMemories(dir, 'project-a');
    expect(entries.filter((entry) => entry.status === 'active')).toEqual([active]);
    expect(entries.filter((entry) => entry.status === 'proposed')).toHaveLength(2);
    expect(entries.filter((entry) => entry.status === 'proposed').every((entry) => entry.reviewReason === 'conflict' && entry.conflictsWith?.includes(active.id))).toBe(true);
  });

  it('recovers an interrupted receipt after ledger publication without duplicating the proposal', async () => {
    const { call } = await startTask();
    const originalWrite = memoryLedger.writeMemoryFileAtomic;
    let interrupted = false;
    vi.spyOn(memoryLedger, 'writeMemoryFileAtomic').mockImplementation(async (file, record) => {
      if (!interrupted && file.includes(`${path.sep}task-notes${path.sep}`) && (record as { memoryId?: string }).memoryId) {
        interrupted = true;
        throw new Error('Receipt publication interrupted');
      }
      return originalWrite(file, record);
    });
    const body = 'Preserve the ledger on interruption by publishing a complete replacement atomically.';
    const args = { requestId: 'interruption', kind: 'decision', title: 'Atomic publish', body, evidence: 'Committed rationale.', file: 'docs/decisions.md', quote: body };
    expect((await call(args)).isError).toBe(true);
    const entries = await listProjectMemories(dir, 'project-a');
    expect(entries).toHaveLength(1);
    expect(valueOf(await call(args))).toMatchObject({ id: entries[0].id, status: 'proposed' });
    expect(await listProjectMemories(dir, 'project-a')).toHaveLength(1);
  });

  it('preserves idempotent retries of ledger requests saved by the previous tool', async () => {
    const content = { kind: 'lesson' as const, title: 'Legacy tool guidance', body: 'Inspect the failure before retrying.', source: { type: 'task' as const, reference: '001-failure', evidence: 'Task report.' } };
    const saved = await mutateProjectMemory(dir, 'project-a', { action: 'propose', requestId: 'task:001-failure:legacy', content });
    const { call } = await startTask();
    const result = valueOf(await call({ requestId: 'legacy', kind: content.kind, title: content.title, body: content.body, evidence: content.source.evidence }));
    expect(result.id).toBe(saved.id);
    expect(result.status).toBe('proposed');
    let entry = (await listProjectMemories(dir, 'project-a'))[0];
    entry = await mutateProjectMemory(dir, 'project-a', { action: 'accept', id: entry.id, expectedRevision: entry.revision });
    const retry = valueOf(await call({ requestId: 'legacy', kind: content.kind, title: content.title, body: content.body, evidence: content.source.evidence }));
    expect(retry).toMatchObject({ id: saved.id, status: 'active', verification: 'user-confirmed', note: expect.stringContaining('this request did not accept or verify it') });
    expect(await listProjectMemories(dir, 'project-a')).toHaveLength(1);
  });

  it('does not advertise an unreachable OMP tool on WSL NAT', async () => {
    transport.route = 'bridge';
    expect(await openTaskMemoryTools({ dir, projectId: 'project-a', specId: '001', tempDir: root, omp: true })).toBeUndefined();
  });
});
