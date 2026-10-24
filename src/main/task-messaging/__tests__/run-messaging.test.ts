import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../platform/shell-runtime', () => ({
  getWslInfo: () => null,
  getShellRuntimeStatus: () => ({}),
  toRuntimePath: (p: string) => p,
  whenShellRuntimeReady: async () => ({}),
}));

import { closeTaskToolsServer } from '../../insights/task-tools-server';
import { configureTaskMessaging, resetTaskMessagingForTests } from '../broker';
import { createRunMessaging } from '../run-messaging';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'run-messaging-'));
  configureTaskMessaging({ getProject: () => undefined, getTasks: () => [] });
});

afterEach(async () => {
  resetTaskMessagingForTests();
  await closeTaskToolsServer();
  rmSync(tmp, { recursive: true, force: true });
});

async function rpc(server: { url: string; headers: Record<string, string> }, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...server.headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
}

describe('createRunMessaging', () => {
  it("gives the run only its messaging tools, on a token that stops working when the run ends", async () => {
    const messaging = createRunMessaging('p1', '001-task');
    expect(messaging.sessionName).toMatch(/^wb-[a-z0-9]{6}-001-task$/);
    const server = await messaging.mcpServer(tmp);
    expect(server?.type).toBe('http');
    const http = server as { url: string; headers: Record<string, string> };

    const listed = await rpc(http, 'tools/list');
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['message_task', 'list_parallel_tasks']);
    const called = await rpc(http, 'tools/call', { name: 'message_task', arguments: { task: 'lead', message: 'hi' } });
    expect(called.body.result.content[0].text).toBe('not sent: no project lead session');
    // The same token serves every phase of the run
    expect((await messaging.mcpServer(tmp))).toEqual(server);

    messaging.dispose();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await rpc(http, 'tools/list')).status).toBe(401);
    expect(await messaging.mcpServer(tmp)).toBeUndefined();
  });
});
