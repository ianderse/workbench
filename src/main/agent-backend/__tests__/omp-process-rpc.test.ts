import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeStreamMessage } from '../../claude-code/stream-types';
import { DEFAULT_OMP_BACKEND_SETTINGS, type OmpBackendSettings } from '../../../shared/types/agent-backend';
import { encodeRpcCommand, isSessionSettled, parseRpcLine, readSteerId, rpcSteer, sessionIdOf, steerText } from '../omp-rpc';
import { buildOmpArgs } from '../omp-args';
import { startOmpProcess } from '../omp-process';

vi.mock('../omp-roles', () => ({ getOmpRoles: () => undefined }));

describe('omp rpc framing', () => {
  it('encodes a command as one JSON line', () => {
    expect(encodeRpcCommand({ id: 'a', type: 'abort' })).toBe('{"id":"a","type":"abort"}\n');
    expect(JSON.parse(rpcSteer('wbm-1', 'hello'))).toEqual({ id: 'steer-wbm-1', type: 'steer', message: 'hello' });
  });

  it('parses ready, responses, events and rubbish', () => {
    expect(parseRpcLine('')).toBeUndefined();
    expect(parseRpcLine('{"type":"ready","protocolVersion":1}')).toEqual({ kind: 'ready' });
    expect(parseRpcLine('{"id":"x","type":"response","command":"steer","success":true}')).toEqual({ kind: 'response', id: 'x', command: 'steer', success: true });
    expect(parseRpcLine('{"id":"x","type":"response","command":"prompt","success":false,"error":"no"}')).toMatchObject({ success: false, error: 'no' });
    expect(parseRpcLine('{"type":"agent_start"}')).toEqual({ kind: 'event', event: { type: 'agent_start' } });
    expect(parseRpcLine('warning: something')).toEqual({ kind: 'invalid' });
    expect(parseRpcLine('{"broken')).toEqual({ kind: 'invalid' });
    expect(parseRpcLine('[1]')).toEqual({ kind: 'invalid' });
  });

  it('matches the injected user message to its marker', () => {
    const text = steerText('look at b.ts', 'wbm-abc');
    const event = { type: 'message_end', message: { role: 'user', attribution: 'user', content: [{ type: 'text', text }] } };
    expect(readSteerId(event)).toBe('wbm-abc');
    expect(readSteerId({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'plain prompt' }] } })).toBeUndefined();
    expect(readSteerId({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })).toBeUndefined();
    expect(readSteerId({ type: 'message_start', message: { role: 'user', content: text } })).toBeUndefined();
    expect(isSessionSettled({ type: 'session_settled' })).toBe(true);
    expect(sessionIdOf({ sessionId: 's1' })).toBe('s1');
    expect(sessionIdOf({})).toBeUndefined();
  });

  it('builds rpc arguments instead of -p --mode json', () => {
    const args = buildOmpArgs({ settings: DEFAULT_OMP_BACKEND_SETTINGS, tools: ['bash'], transport: 'rpc', session: { dir: '/s' } });
    expect(args.slice(0, 4)).toEqual(['--mode', 'rpc', '--no-ui', '--no-title']);
    expect(args).not.toContain('-p');
    expect(buildOmpArgs({ settings: DEFAULT_OMP_BACKEND_SETTINGS, tools: ['bash'] }).slice(0, 3)).toEqual(['-p', '--mode', 'json']);
  });
});

/** A stand-in for `omp`: speaks the RPC protocol with `--mode rpc`, prints json events with `-p` */
const FAKE_OMP = `#!/usr/bin/env node
const mode = process.env.FAKE_MODE || 'ok';
const rpc = process.argv.includes('rpc');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text) => ({ role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', usage, content: [{ type: 'text', text }] });
const finish = (text) => {
  out({ type: 'message_end', message: assistant(text) });
  out({ type: 'agent_end', messages: [] });
};
if (!rpc) {
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    out({ type: 'session', id: 'print-session', cwd: process.cwd() });
    out({ type: 'agent_start' });
    finish('print answer: ' + input.trim());
  });
} else if (mode === 'rpc-exit') {
  process.stderr.write('unknown option --mode rpc\\n');
  process.exit(1);
} else if (mode === 'rpc-silent') {
  setInterval(() => {}, 1000);
  process.stdin.resume();
} else if (mode === 'rpc-garbage') {
  process.stdout.write('this is not json\\n');
  setInterval(() => {}, 1000);
  process.stdin.resume();
} else {
  out({ type: 'ready', protocolVersion: 1 });
  let buf = '';
  let steered = false;
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const cmd = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (cmd.type === 'get_state') out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session' } });
      if (cmd.type === 'prompt') {
        out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        out({ type: 'agent_start' });
        out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: cmd.message }] } });
        // Without a steer the run ends by itself
        setTimeout(() => {
          if (!steered || mode === 'rpc-ignore') endRun('final answer');
        }, mode === 'rpc-ignore' ? 700 : 1500);
      }
      if (cmd.type === 'steer') {
        steered = true;
        out({ id: cmd.id, type: 'response', command: 'steer', success: true });
        if (mode !== 'rpc-ignore') {
          out({ type: 'message_end', message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: cmd.message }] } });
          setTimeout(() => endRun('saw the steer'), 100);
        }
      }
    }
  });
  const endRun = (text) => {
    finish(text);
    out({ type: 'prompt_result', id: 'wb-prompt', status: 'completed' });
    out({ type: 'session_settled' });
  };
  process.stdin.on('end', () => process.exit(0));
}
`;

describe('startOmpProcess with live messages', () => {
  let dir: string;
  let fake: string;
  const settings = (patch: Partial<OmpBackendSettings> = {}): OmpBackendSettings => ({ ...DEFAULT_OMP_BACKEND_SETTINGS, command: fake, ...patch });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'omp-rpc-test-'));
    fake = path.join(dir, 'omp');
    await writeFile(fake, FAKE_OMP, 'utf-8');
    await chmod(fake, 0o755);
  });
  afterEach(async () => {
    delete process.env.FAKE_MODE;
    await rm(dir, { recursive: true, force: true });
  });

  const run = (mode: string, extra: Partial<Parameters<typeof startOmpProcess>[0]> = {}) => {
    const messages: ClaudeStreamMessage[] = [];
    const read: Array<{ id: string; text: string }> = [];
    const promise = startOmpProcess({
      settings: settings(),
      cwd: dir,
      env: { FAKE_MODE: mode },
      prompt: 'do the thing',
      tools: ['bash'],
      live: { onInputRead: (id, text) => read.push({ id, text }) },
      onMessage: (m) => messages.push(m),
      rpcWaitsMs: { ready: 400, start: 400, settle: 400, state: 400 },
      ...extra,
    });
    return { messages, read, promise };
  };
  const text = (messages: ClaudeStreamMessage[]) => (messages.find((m) => m.type === 'result') as { result?: string } | undefined)?.result;

  it('steers a message into the running step, reports it read and ends the process', async () => {
    const { messages, read, promise } = run('rpc-ok');
    const handle = await promise;
    // The step is starting: the message is accepted and written once the run began
    await new Promise((r) => setTimeout(r, 300));
    const id = handle.send('please also check b.ts', 'wbm-test1');
    expect(id).toBe('wbm-test1');
    const outcome = await handle.done;
    expect(read).toEqual([{ id: 'wbm-test1', text: 'please also check b.ts' }]);
    expect(outcome.unread).toEqual([]);
    expect(text(messages)).toBe('saw the steer');
    expect(messages.find((m) => m.type === 'system')).toMatchObject({ subtype: 'init', session_id: 'rpc-session' });
    expect(outcome.exitCode).toBe(0);
    // The run is over: no more messages are taken
    expect(handle.send('late')).toBe(false);
  });

  it('returns a message the model never read as unread', async () => {
    const { read, promise } = run('rpc-ignore');
    const handle = await promise;
    await new Promise((r) => setTimeout(r, 300));
    expect(handle.send('too late for this run', 'wbm-test2')).toBe('wbm-test2');
    const outcome = await handle.done;
    expect(read).toEqual([]);
    expect(outcome.unread).toEqual([{ id: 'wbm-test2', text: 'too late for this run' }]);
  });

  it('runs without a steer to the end and closes the process', async () => {
    const { messages, promise } = run('rpc-ok');
    const outcome = await (await promise).done;
    expect(text(messages)).toBe('final answer');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.is_error).toBe(false);
  });

  it.each(['rpc-exit', 'rpc-silent', 'rpc-garbage'])('falls back to omp -p when the RPC process misbehaves (%s)', async (mode) => {
    const { messages, promise } = run(mode);
    const handle = await promise;
    const early = handle.send('early message', 'wbm-test3');
    const outcome = await handle.done;
    expect(text(messages)).toBe('print answer: do the thing');
    expect(outcome.result?.is_error).toBe(false);
    // A message taken while the RPC process was starting goes back to the inbox with the unread ones
    if (early) expect(outcome.unread).toEqual([{ id: 'wbm-test3', text: 'early message' }]);
    expect(handle.send('after the fallback')).toBe(false);
  });

  it('uses omp -p when the setting is off, for utility calls, without live options and with attachments', async () => {
    for (const extra of [
      { settings: settings({ liveMessages: false }) },
      { oneShot: true },
      { live: undefined },
      { prompt: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] as never },
    ]) {
      const { messages, promise } = run('rpc-ok', extra as never);
      const handle = await promise;
      expect(handle.send('x')).toBe(false);
      await handle.done;
      expect(text(messages)).toMatch(/^print answer: /);
    }
  });
});
