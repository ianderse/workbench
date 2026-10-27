import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { closeTaskToolsServer } from '../../insights/task-tools-server';
import { openTaskMemoryTools } from '../task-memory';
import { listProjectMemories } from '../project-memory';

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
afterEach(async () => { close?.(); close = undefined; await closeTaskToolsServer(); await rm(root, { recursive: true, force: true }); });

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
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'proposed', verification: 'unverified', source: { type: 'task', reference: '001-failure' } });
    expect((await call('tools/call', { name: 'accept', arguments: { id: entries[0].id } })).body.result.isError).toBe(true);
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
    expect(JSON.parse(result.content[0].text).status).toBe('proposed');
    await writeFile(path.join(root, '.workbench', 'settings.json'), JSON.stringify({ selfImprove: false }));
    await expect(registered[0].execute('call-2', { ...args, requestId: 'another' })).rejects.toThrow('disabled');
    expect(await listProjectMemories(dir, 'project-a')).toHaveLength(1);
  });

  it('does not advertise an unreachable OMP tool on WSL NAT', async () => {
    transport.route = 'bridge';
    expect(await openTaskMemoryTools({ dir, projectId: 'project-a', specId: '001', tempDir: root, omp: true })).toBeUndefined();
  });
});
