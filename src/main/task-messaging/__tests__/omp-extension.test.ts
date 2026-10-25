import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOmpMessagingExtension, writeOmpMessagingExtension } from '../omp-extension';
import { TASK_RUN_TOOLS } from '../tools';

let server: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('OMP messaging extension', () => {
  it('is generated from the Claude tool definitions', () => {
    const source = buildOmpMessagingExtension({ url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } });
    expect(source).toContain('export default function (pi)');
    for (const tool of TASK_RUN_TOOLS) {
      expect(source).toContain(JSON.stringify(tool.name));
      expect(source).toContain(JSON.stringify(tool.description));
    }
    expect(source).toContain("loadMode: 'essential'");
    expect(source).toContain('"Authorization": "Bearer t"');
  });

  it('is written only for an HTTP server', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'omp-ext-'));
    expect(await writeOmpMessagingExtension(dir, undefined)).toBeUndefined();
    expect(await writeOmpMessagingExtension(dir, { type: 'stdio', command: 'x', args: [], env: {} })).toBeUndefined();
    const file = await writeOmpMessagingExtension(dir, { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: {} });
    expect(file && (await readFile(file, 'utf-8'))).toContain('registerTool');
  });

  it('registers the tools and calls the tools server with the token (stub server)', async () => {
    const requests: Array<{ auth?: string; body: { method: string; params: { name: string; arguments: unknown } } }> = [];
    server = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => (data += chunk));
      request.on('end', () => {
        const body = JSON.parse(data);
        requests.push({ auth: request.headers.authorization, body });
        const failing = body.params.name === 'list_parallel_tasks';
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: failing ? 'broken' : 'queued: 002 reads it later' }], ...(failing ? { isError: true } : {}) },
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    dir = await mkdtemp(path.join(os.tmpdir(), 'omp-ext-'));
    const file = (await writeOmpMessagingExtension(dir, { type: 'http', url, headers: { Authorization: 'Bearer run-token' } }))!;

    const registered: Array<{ name: string; parameters: unknown; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> = [];
    const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href);
    loaded.default({ registerTool: (tool: (typeof registered)[number]) => registered.push(tool) });
    expect(registered.map((t) => t.name)).toEqual(TASK_RUN_TOOLS.map((t) => t.name));
    expect(registered[0].parameters).toEqual(TASK_RUN_TOOLS[0].inputSchema);

    // OMP adds an `i` (intent) argument; it is not passed on
    const sent = await registered[0].execute('c1', { task: '002', message: 'hi', i: 'telling 002' });
    expect(sent.content[0].text).toBe('queued: 002 reads it later');
    expect(requests[0].auth).toBe('Bearer run-token');
    expect(requests[0].body).toMatchObject({ method: 'tools/call', params: { name: 'message_task', arguments: { task: '002', message: 'hi' } } });

    await expect(registered[1].execute('c2', {})).rejects.toThrow('broken');
  });
});
