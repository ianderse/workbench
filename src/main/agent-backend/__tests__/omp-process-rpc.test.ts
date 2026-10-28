import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeStreamMessage } from '../../claude-code/stream-types';
import { DEFAULT_OMP_BACKEND_SETTINGS, type OmpBackendSettings } from '../../../shared/types/agent-backend';
import { encodeRpcCommand, isSessionSettled, parseRpcLine, readSteerId, rpcPrompt, rpcSteer, sessionIdOf, steerText } from '../omp-rpc';
import { buildOmpArgs, OMP_FOREGROUND_OVERLAY, OMP_FOREGROUND_RULE } from '../omp-args';
import { startOmpProcess } from '../omp-process';
import { appLog } from '../../app-logger';

const recoveryFixture = vi.hoisted(() => ({ file: '', chains: {} as Record<string, string[]> }));
vi.mock('../omp-roles', () => ({ getOmpRoles: () => undefined, getOmpFallbackPolicy: async () => ({ roles: undefined, chains: recoveryFixture.chains }) }));
vi.mock('../omp-cooldown', async (original) => {
  const actual = await original<typeof import('../omp-cooldown')>();
  return { ...actual, getOmpCooldownStore: () => new actual.OmpCooldownStore(recoveryFixture.file) };
});

describe('omp rpc framing', () => {
  it('encodes a command as one JSON line', () => {
    expect(encodeRpcCommand({ id: 'a', type: 'abort' })).toBe('{"id":"a","type":"abort"}\n');
    expect(JSON.parse(rpcSteer('wbm-1', 'hello'))).toEqual({ id: 'steer-wbm-1', type: 'steer', message: 'hello' });
    expect(JSON.parse(rpcPrompt('look', [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]))).toEqual({ id: 'wb-prompt', type: 'prompt', message: 'look', images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
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
if (process.env.FAKE_ARGV_OUT) {
  const argv = process.argv.slice(2);
  const configs = argv.flatMap((a, i) => (argv[i - 1] === '--config' ? [require('fs').readFileSync(a, 'utf-8')] : []));
  require('fs').writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify({ argv, configs }));
  if (process.env.FAKE_ARGV_HISTORY) {
    const extensions = argv.flatMap((a, i) => argv[i - 1] === '-e' ? [require('fs').readFileSync(a, 'utf-8')] : []);
    require('fs').appendFileSync(process.env.FAKE_ARGV_HISTORY, JSON.stringify({ argv, extensions }) + '\\n');
  }
}
const rpc = process.argv.includes('rpc');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const sessionFile = require('path').join(process.cwd(), 'rpc-session.jsonl');
if (rpc) require('fs').writeFileSync(sessionFile, '{"type":"session","id":"rpc-session"}\\n');
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
    const model = process.argv[process.argv.indexOf('--model') + 1];
    if (mode === 'provider-cooldown' && model.startsWith('quota-fixture/')) {
      out({ type: 'message_end', message: { role: 'assistant', provider: 'quota-fixture', model: 'limited', stopReason: 'error', usage, content: [], errorMessage: '429 rate_limit_error retry-after-ms=246899000' } });
      out({ type: 'agent_end', messages: [] });
    } else if (mode === 'utility-repair') finish(input.includes('<answer>') ? '{"memories":[]}' : 'not JSON yet');
    else if (mode === 'rpc-repair') finish('{"value":"fixed"}');
    else finish('print answer: ' + input.trim());
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
  let jobPending = false;
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const cmd = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (cmd.type === 'get_state') {
        if (mode === 'rpc-state-missing') out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { hasPendingAsyncWork: jobPending } });
        else if (mode === 'rpc-state-failed') out({ id: cmd.id, type: 'response', command: 'get_state', success: false, error: 'state unavailable' });
        else out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session', sessionFile, hasPendingAsyncWork: jobPending } });
      }
      if (cmd.type === 'prompt') {
        if (process.env.FAKE_EXPECT_ACK && !require('fs').existsSync(process.env.FAKE_EXPECT_ACK)) { process.stderr.write('prompt arrived before durable acknowledgment'); process.exit(9); }
        if (process.env.FAKE_PROMPT_OUT) require('fs').writeFileSync(process.env.FAKE_PROMPT_OUT, JSON.stringify(cmd));
        if (mode === 'rpc-refuse') {
          out({ id: cmd.id, type: 'response', command: 'prompt', success: false, error: 'busy' });
          continue;
        }
        if (mode === 'rpc-exit-after-prompt') process.exit(7);
        out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
        if (mode === 'rpc-hang') continue;
        // omp compacts a too-large resumed session before agent_start
        const delay = mode === 'rpc-slow-start' ? 1200 : mode === 'rpc-compact' ? 1200 : 0;
        if (mode === 'rpc-compact') out({ type: 'auto_compaction_start', reason: 'threshold' });
        setTimeout(() => {
          if (mode === 'rpc-compact') out({ type: 'auto_compaction_end' });
          out({ type: 'agent_start' });
          out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: cmd.message }] } });
          // Without a steer the run ends by itself
          setTimeout(() => {
          if (!steered || mode === 'rpc-ignore') endRun(mode === 'rpc-repair' ? 'not JSON yet' : 'final answer');
          }, mode === 'rpc-ignore' ? 700 : 1500);
        }, delay);
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
    if (mode.startsWith('rpc-job')) {
      // The model backgrounded a bash job and ended its turn: not settled until the job's result was handled
      out({ type: 'prompt_result', id: 'wb-prompt', status: 'completed', sessionSettled: false });
      jobPending = true;
      if (mode === 'rpc-job') {
        setTimeout(() => {
          jobPending = false;
          out({ type: 'agent_start' });
          out({ type: 'message_end', message: { role: 'custom', customType: 'async-result', content: 'Background job bg_1 has completed' } });
          finish('tests passed');
          out({ type: 'session_settled' });
        }, 1500);
      } else if (mode === 'rpc-job-lost') {
        // The job died without a result: only get_state shows it
        setTimeout(() => { jobPending = false; }, 1000);
      }
      return;
    }
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
    recoveryFixture.file = path.join(dir, 'cooldowns.json');
    recoveryFixture.chains = {};
    if (process.platform === 'win32') {
      // Windows cannot execute a shebang script: a .cmd wrapper (run through a shell, like npm's omp shim) starts it with node
      await writeFile(path.join(dir, 'omp.js'), FAKE_OMP, 'utf-8');
      fake = path.join(dir, 'omp.cmd');
      await writeFile(fake, '@echo off\r\nnode "%~dp0omp.js" %*\r\n', 'utf-8');
    } else {
      fake = path.join(dir, 'omp');
      await writeFile(fake, FAKE_OMP, 'utf-8');
      await chmod(fake, 0o755);
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.FAKE_MODE;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      // `ready` waits on a fresh node process, which a loaded machine (the full suite) can take seconds to start;
      // the misbehaving modes that test a missing `ready` shorten it themselves
      rpcWaitsMs: { ready: 5000, start: 400, settle: 400, state: 400 },
      ...extra,
    });
    return { messages, read, promise };
  };
  const text = (messages: ClaudeStreamMessage[]) => (messages.find((m) => m.type === 'result') as { result?: string } | undefined)?.result;

  it('switches immediately through the real CLI transport, then skips the exhausted provider on the next run', async () => {
    recoveryFixture.chains = { 'quota-fixture/*': ['available-fixture/model'] };
    const argvFile = path.join(dir, 'cooldown-argv.json');
    const messages: ClaudeStreamMessage[] = [];
    const options = { settings: settings(), cwd: dir, env: { FAKE_MODE: 'provider-cooldown', FAKE_ARGV_OUT: argvFile }, model: 'quota-fixture/limited', prompt: 'Check the existing work before continuing', tools: [] as string[], session: { dir: path.join(dir, 'sessions') }, onMessage: (message: ClaudeStreamMessage) => messages.push(message) };
    const first = await startOmpProcess(options);
    expect((await first.done).result?.is_error).toBe(false);
    const firstArgv = JSON.parse(await readFile(argvFile, 'utf8')).argv as string[];
    expect(firstArgv[firstArgv.indexOf('--model') + 1]).toBe('available-fixture/model');
    expect(firstArgv[firstArgv.indexOf('--resume') + 1]).toBe('print-session');
    expect(messages).toContainEqual(expect.objectContaining({ text: expect.stringContaining('switching immediately') }));
    const second = await startOmpProcess(options);
    expect((await second.done).result?.is_error).toBe(false);
    const secondArgv = JSON.parse(await readFile(argvFile, 'utf8')).argv as string[];
    expect(secondArgv[secondArgv.indexOf('--model') + 1]).toBe('available-fixture/model');
  });

  it('turns background bash off in the RPC run too', async () => {
    const argvFile = path.join(dir, 'argv.json');
    const { promise } = run('rpc-ok', { env: { FAKE_MODE: 'rpc-ok', FAKE_ARGV_OUT: argvFile } });
    await (await promise).done;
    const seen = JSON.parse(await readFile(argvFile, 'utf-8')) as { argv: string[]; configs: string[] };
    expect(seen.argv).toContain('rpc');
    expect(seen.configs).toContain(OMP_FOREGROUND_OVERLAY);
  });

  it('keeps both the tool-free utility and its JSON repair isolated through the CLI transport', async () => {
    const log = vi.spyOn(appLog, 'info');
    const history = path.join(dir, 'argv-history.jsonl');
    const handle = await startOmpProcess({ settings: settings(), cwd: dir, model: 'fixture/small', tools: [], oneShot: true,
      systemPrompt: 'Extract project memories.', prompt: 'Outcome', jsonSchema: { type: 'object', required: ['memories'], properties: { memories: { type: 'array' } } },
      env: { FAKE_MODE: 'utility-repair', FAKE_ARGV_OUT: path.join(dir, 'argv.json'), FAKE_ARGV_HISTORY: history } });
    const outcome = await handle.done;
    expect(outcome.result?.structured_output).toEqual({ memories: [] });
    const calls = (await readFile(history, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; extensions: string[] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.argv).toContain('--no-tools');
      expect(call.argv).toContain('--no-context-files');
      expect(call.argv).toContain('--no-rules');
      expect(call.extensions).toHaveLength(1);
      expect(call.extensions[0]).toContain("pi.on('before_provider_request'");
    }
    expect(calls[0].extensions[0]).toContain('Extract project memories.');
    expect(calls[1].extensions[0]).toContain('Format the supplied answer');
    const diagnostics = log.mock.calls.filter(call => call[0] === '[OMP prompt]').map(call => JSON.parse(call[1] as string));
    expect(diagnostics.filter(row => row.event === 'launch')).toEqual([
      expect.objectContaining({ attempt: 1, purpose: 'run', transport: 'print', tools: 'none', resumed: false }),
      expect.objectContaining({ attempt: 2, purpose: 'json-repair', transport: 'print', tools: 'none', resumed: false, systemPrompt: { chars: 0, bytes: 0 } }),
    ]);
    expect(diagnostics.filter(row => row.event === 'reply-usage')).toEqual([
      expect.objectContaining({ attempt: 1, input: 1, output: 1 }),
      expect.objectContaining({ attempt: 2, input: 1, output: 1 }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('Extract project memories.');
  });

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

  it('keeps the process open past agent_end while a background job is pending and ends with the follow-up run', async () => {
    const { messages, promise } = run('rpc-job');
    const handle = await promise;
    const started = Date.now();
    const outcome = await handle.done;
    // The settle wait is 400 ms, the job finishes about 1500 ms after the first agent_end
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(text(messages)).toBe('tests passed');
    expect(messages.filter((m) => m.type === 'result')).toHaveLength(1);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result?.is_error).toBe(false);
  });

  it('accepts live messages while it waits for a background job', async () => {
    const { promise } = run('rpc-job');
    const handle = await promise;
    await new Promise((r) => setTimeout(r, 1000));
    expect(handle.send('while the job runs', 'wbm-job1')).toBe('wbm-job1');
    await handle.done;
  });

  it('settles once the job is gone without a result', async () => {
    const { messages, promise } = run('rpc-job-lost', { rpcWaitsMs: { ready: 5000, start: 400, settle: 400, state: 400, poll: 200 } });
    const outcome = await (await promise).done;
    expect(text(messages)).toBe('final answer');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
  });

  it('is bounded by the step timeout when a job never finishes', async () => {
    const { promise } = run('rpc-job-forever', { timeoutMs: 3000 });
    const started = Date.now();
    const outcome = await (await promise).done;
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('turns background bash off in print mode and adds the foreground rule', async () => {
    const args = buildOmpArgs({ settings: DEFAULT_OMP_BACKEND_SETTINGS, tools: ['bash'], foregroundOverlayFile: '/o/fg.yml' });
    expect(args).toContain('--config');
    expect(args[args.indexOf('--config') + 1]).toBe('/o/fg.yml');
    expect(OMP_FOREGROUND_OVERLAY).toContain('enabled: false');
    expect(OMP_FOREGROUND_RULE).toMatch(/foreground/);
  });

  it.each(['rpc-exit', 'rpc-silent', 'rpc-garbage'])('falls back to omp -p when the RPC process misbehaves (%s)', async (mode) => {
    const log = vi.spyOn(appLog, 'info');
    const { messages, promise } = run(mode, { rpcWaitsMs: { ready: 400, start: 400, settle: 400, state: 400 } });
    const handle = await promise;
    const early = handle.send('early message', 'wbm-test3');
    const outcome = await handle.done;
    expect(text(messages)).toBe('print answer: do the thing');
    expect(outcome.result?.is_error).toBe(false);
    // A message taken while the RPC process was starting goes back to the inbox with the unread ones
    if (early) expect(outcome.unread).toEqual([{ id: 'wbm-test3', text: 'early message' }]);
    expect(handle.send('after the fallback')).toBe(false);
    const launches = log.mock.calls.filter(call => call[0] === '[OMP prompt]').map(call => JSON.parse(call[1] as string)).filter(row => row.event === 'launch');
    expect(launches).toEqual([
      expect.objectContaining({ attempt: 1, transport: 'rpc' }),
      expect.objectContaining({ attempt: 2, transport: 'print' }),
    ]);
    // Ending the RPC process and starting the print-mode one is two process launches (through cmd.exe and node on Windows)
  }, 30_000);

  it.each(['rpc-slow-start', 'rpc-compact'])('does not fall back when agent_start is slow after the prompt was accepted (%s)', async (mode) => {
    const log = vi.spyOn(appLog, 'info');
    const { messages, promise } = run(mode);
    const handle = await promise;
    const outcome = await handle.done;
    // The 400 ms start wait passed long before agent_start (1200 ms): the RPC run was kept
    expect(text(messages)).toBe('final answer');
    expect(outcome.exitCode).toBe(0);
    expect(messages.find((m) => m.type === 'system')).toMatchObject({ session_id: 'rpc-session' });
    const diagnostics = log.mock.calls.filter(call => call[0] === '[OMP prompt]').map(call => JSON.parse(call[1] as string));
    expect(diagnostics.filter(row => row.event === 'reply-usage')).toEqual([expect.objectContaining({ attempt: 1, input: 1, output: 1 })]);
    if (mode === 'rpc-compact') {
      expect(diagnostics.map(row => row.event)).toEqual(['launch', 'auto_compaction_start', 'auto_compaction_end', 'reply-usage']);
    }
  });

  it('keeps messages sent during the compaction and delivers them after agent_start', async () => {
    const { read, messages, promise } = run('rpc-compact');
    const handle = await promise;
    // Prompt accepted, compaction running (agent_start comes at about 1200 ms)
    await new Promise((r) => setTimeout(r, 700));
    expect(handle.send('during compaction', 'wbm-test4')).toBe('wbm-test4');
    const outcome = await handle.done;
    expect(read).toEqual([{ id: 'wbm-test4', text: 'during compaction' }]);
    expect(outcome.unread).toEqual([]);
    expect(text(messages)).toBe('saw the steer');
  });

  it('falls back to omp -p when the prompt is refused', async () => {
    const { messages, promise } = run('rpc-refuse');
    const outcome = await (await promise).done;
    expect(text(messages)).toBe('print answer: do the thing');
    expect(outcome.result?.is_error).toBe(false);
  });

  it('gives up on a silent process after the prompt was accepted, without repeating the step in print mode', async () => {
    const { messages, promise } = run('rpc-hang', { rpcWaitsMs: { ready: 400, start: 400, settle: 400, state: 400, hang: 600 } });
    const outcome = await (await promise).done;
    expect(text(messages)).not.toMatch(/^print answer/);
    expect(outcome.result?.is_error).toBe(true);
    expect(outcome.stderr).toContain('no output from omp');
  });

  it('uses omp -p when the setting is off, for utility calls, without live options and with document attachments', async () => {
    for (const extra of [
      { settings: settings({ liveMessages: false }) },
      { oneShot: true },
      { live: undefined },
      { prompt: [{ type: 'text', text: 'look' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } }] as never },
    ]) {
      const { messages, promise } = run('rpc-ok', extra as never);
      const handle = await promise;
      expect(handle.send('x')).toBe(false);
      await handle.done;
      expect(text(messages)).toMatch(/^print answer: /);
    }
  });

  it('preserves native image payloads and awaits durable session acknowledgment before its first prompt', async () => {
    const acknowledgment = path.join(dir, 'acknowledged');
    const payload = path.join(dir, 'prompt.json');
    const onSessionReady = vi.fn(async () => { await writeFile(acknowledgment, 'durable'); });
    const { promise } = run('rpc-ok', {
      settings: settings({ liveMessages: false }), live: undefined, onSessionReady,
      env: { FAKE_MODE: 'rpc-ok', FAKE_EXPECT_ACK: acknowledgment, FAKE_PROMPT_OUT: payload },
      prompt: [{ type: 'text', text: 'look at the original image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
    });
    const outcome = await (await promise).done;
    expect(outcome.result?.is_error).toBeFalsy();
    expect(onSessionReady).toHaveBeenCalledWith('rpc-session');
    expect(JSON.parse(await readFile(payload, 'utf8'))).toMatchObject({ message: 'look at the original image', images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
  });

  it('does not submit the prompt while durable session acknowledgment is still pending', async () => {
    const payload = path.join(dir, 'prompt.json');
    let release!: () => void;
    const acknowledgment = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const { promise } = run('rpc-ok', {
      settings: settings({ liveMessages: false }), live: undefined,
      env: { FAKE_MODE: 'rpc-ok', FAKE_PROMPT_OUT: payload },
      onSessionReady: async () => { entered(); await acknowledgment; },
      rpcWaitsMs: { ready: 5000, start: 2000, settle: 400, state: 400 },
    });
    const handle = await promise;
    await callbackEntered;
    await expect(readFile(payload, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    release();
    expect((await handle.done).result?.is_error).toBe(false);
    expect(JSON.parse(await readFile(payload, 'utf8'))).toMatchObject({ type: 'prompt', message: 'do the thing' });
  });

  it('bounds a stuck session acknowledgment and cannot submit a late prompt after the callback resolves', async () => {
    const payload = path.join(dir, 'prompt.json');
    const history = path.join(dir, 'history.jsonl');
    let release!: () => void;
    const acknowledgment = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const { promise } = run('rpc-ok', {
      env: { FAKE_MODE: 'rpc-ok', FAKE_PROMPT_OUT: payload, FAKE_ARGV_OUT: path.join(dir, 'argv.json'), FAKE_ARGV_HISTORY: history },
      onSessionReady: async () => { entered(); await acknowledgment; },
      rpcWaitsMs: { ready: 5000, start: 150, settle: 100, state: 100 },
    });
    const handle = await promise;
    await callbackEntered;
    await expect(handle.done).rejects.toThrow(/acknowledgment|RPC/i);
    await expect(readFile(payload, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const launches = (await readFile(history, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(launches).toHaveLength(1);
    expect(launches[0].argv).toContain('rpc');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(readFile(payload, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['rpc-state-missing', 'rpc-state-failed'])('fails closed without a prompt or print replay when session identity is unavailable (%s)', async (mode) => {
    const payload = path.join(dir, 'prompt.json');
    const history = path.join(dir, 'history.jsonl');
    const { promise } = run(mode, {
      env: { FAKE_MODE: mode, FAKE_PROMPT_OUT: payload, FAKE_ARGV_OUT: path.join(dir, 'argv.json'), FAKE_ARGV_HISTORY: history },
      onSessionReady: async () => undefined,
    });
    await expect((await promise).done).rejects.toThrow(/session identity|durable acknowledgment|RPC/);
    await expect(readFile(payload, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const launches = (await readFile(history, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(launches).toHaveLength(1);
    expect(launches[0].argv).toContain('rpc');
  });

  it.each([false, true])('never print-replays a prompt whose RPC acceptance is uncertain (strict=%s)', async (strict) => {
    const payload = path.join(dir, 'prompt.json');
    const history = path.join(dir, 'history.jsonl');
    const { promise } = run('rpc-exit-after-prompt', {
      env: { FAKE_MODE: 'rpc-exit-after-prompt', FAKE_PROMPT_OUT: payload, FAKE_ARGV_OUT: path.join(dir, 'argv.json'), FAKE_ARGV_HISTORY: history },
      ...(strict ? { onSessionReady: async () => undefined } : {}),
    });
    const handle = await promise;
    await expect(handle.done).rejects.toThrow(/prompt was sent.*acceptance is uncertain/i);
    expect(JSON.parse(await readFile(payload, 'utf8'))).toMatchObject({ type: 'prompt', message: 'do the thing' });
    const launches = (await readFile(history, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(launches).toHaveLength(1);
    expect(launches[0].argv).toContain('rpc');
  });

  it('repairs malformed JSON by resuming the acknowledged session without creating another identity', async () => {
    const history = path.join(dir, 'history.jsonl');
    const onSessionReady = vi.fn(async () => undefined);
    const handle = await startOmpProcess({
      settings: settings({ liveMessages: false }), cwd: dir, model: 'fixture/small', tools: [], session: { dir },
      prompt: 'Return the object', jsonSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } },
      env: { FAKE_MODE: 'rpc-repair', FAKE_ARGV_OUT: path.join(dir, 'argv.json'), FAKE_ARGV_HISTORY: history },
      onSessionReady, rpcWaitsMs: { ready: 5000, start: 400, settle: 400, state: 400 },
    });
    const outcome = await handle.done;
    expect(outcome.result?.structured_output).toEqual({ value: 'fixed' });
    expect(onSessionReady).toHaveBeenCalledTimes(1);
    expect(onSessionReady).toHaveBeenCalledWith('rpc-session');
    const calls = (await readFile(history, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    expect(calls).toHaveLength(2);
    expect(calls[0].argv).toContain('rpc');
    expect(calls[1].argv).not.toContain('rpc');
    expect(calls[1].argv[calls[1].argv.indexOf('--resume') + 1]).toBe('rpc-session');
  });

  it('never submits a prompt or falls back to print mode after session acknowledgment fails', async () => {
    const payload = path.join(dir, 'prompt.json');
    const history = path.join(dir, 'history.jsonl');
    const argv = path.join(dir, 'argv.json');
    const { promise } = run('rpc-ok', {
      env: { FAKE_MODE: 'rpc-ok', FAKE_PROMPT_OUT: payload, FAKE_ARGV_OUT: argv, FAKE_ARGV_HISTORY: history },
      onSessionReady: async () => { throw new Error('Disk full'); },
    });
    await expect((await promise).done).rejects.toThrow('Fresh context RPC launch failed');
    await expect(readFile(payload, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const launches = (await readFile(history, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(launches).toHaveLength(1);
    expect(launches[0].argv).toContain('rpc');
  });

  it('rejects document attachments before a critical replacement session can submit anything', async () => {
    const { promise } = run('rpc-ok', { onSessionReady: async () => undefined,
      prompt: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } }],
    });
    await expect(promise).rejects.toThrow('document attachments');
  });
});
