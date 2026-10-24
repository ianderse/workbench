import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** A fake Claude Code child process: what the app writes to stdin, and stdout we script */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  written: string[] = [];
  stdinEnded = false;
  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.written.push(...chunk.split('\n').filter(Boolean)));
    this.stdin.on('finish', () => { this.stdinEnded = true; });
  }
  emitLine(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit('close', code, null);
  }
}

const children: FakeChild[] = [];
vi.mock('../../platform/runtime-exec', () => ({
  spawnTool: vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  }),
  killRuntimeProcess: vi.fn(),
}));

import { INITIAL_INPUT_ID, matchReplayedInput, startClaudeProcess } from '../process';
import type { ClaudeStreamMessage } from '../stream-types';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const replay = (text: string | unknown[]) => ({
  type: 'user',
  isReplay: true,
  parent_tool_use_id: null,
  message: { role: 'user', content: typeof text === 'string' ? [{ type: 'text', text }] : text },
});
const result = (fields: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', ...fields });

describe('startClaudeProcess with stdin kept open', () => {
  beforeEach(() => {
    children.length = 0;
  });

  it('keeps stdin open, matches read receipts and closes stdin when the turn ends', async () => {
    const reads: Array<[string, string]> = [];
    const handle = startClaudeProcess({
      command: 'claude', args: [], cwd: '/tmp', env: {},
      input: [{ type: 'text', text: 'Do the task' }],
      keepStdinOpen: true,
      onInputRead: (id, text) => reads.push([id, text]),
    });
    const child = children[0];
    await tick();
    expect(child.written).toHaveLength(1);
    expect(child.stdinEnded).toBe(false);

    const id = handle.send('[Workbench] Task 002 started.', 'wbm-abc123');
    expect(id).toBe('wbm-abc123');
    const unreadId = handle.send('second');
    expect(unreadId).toMatch(/^wbm-/);
    await tick();
    const written = JSON.parse(child.written[1]);
    expect(written.message.content[0].text).toBe('[Workbench] Task 002 started.');
    expect(written.message.content[1].text).toContain('wbm-abc123');

    child.emitLine(replay('Do the task'));
    child.emitLine(replay(written.message.content));
    // Tool results and peer messages are no read receipts of ours
    child.emitLine({ type: 'user', isReplay: true, isSynthetic: true, origin: { kind: 'peer', msg_id: 'x' }, message: { content: 'peer' } });
    child.emitLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
    child.emitLine(result());
    await tick();
    expect(reads).toEqual([[INITIAL_INPUT_ID, 'Do the task'], ['wbm-abc123', '[Workbench] Task 002 started.']]);
    expect(child.stdinEnded).toBe(true);
    expect(handle.send('too late')).toBe(false);

    child.exit(0);
    const outcome = await handle.done;
    expect(outcome.unread).toEqual([{ id: unreadId, text: 'second' }]);
    expect(outcome.results).toHaveLength(1);
  });

  it('reports every result when a late message starts a second turn', async () => {
    const handle = startClaudeProcess({ command: 'claude', args: [], cwd: '/tmp', env: {}, input: 'go', keepStdinOpen: true });
    const child = children[0];
    child.emitLine(result({ structured_output: { plan: 'x' }, total_cost_usd: 0.1 }));
    child.emitLine(result({ total_cost_usd: 0.15 }));
    await tick();
    child.exit(0);
    const outcome = await handle.done;
    expect(outcome.results.map((r) => r.total_cost_usd)).toEqual([0.1, 0.15]);
    expect(outcome.result?.total_cost_usd).toBe(0.15);
  });

  it('writes the prompt and closes stdin right away by default', async () => {
    const handle = startClaudeProcess({ command: 'claude', args: [], cwd: '/tmp', env: {}, input: 'plain prompt' });
    const child = children[0];
    await tick();
    expect(child.written).toEqual(['plain prompt']);
    expect(child.stdinEnded).toBe(true);
    expect(handle.send('x')).toBe(false);
    child.exit(0);
    expect((await handle.done).unread).toEqual([]);
  });
});

describe('matchReplayedInput', () => {
  it('takes the first unmarked replay as the prompt and marked ones by id', () => {
    const plain = replay('hello') as ClaudeStreamMessage;
    expect(matchReplayedInput(plain, false)).toBe(INITIAL_INPUT_ID);
    expect(matchReplayedInput(plain, true)).toBeUndefined();
    expect(matchReplayedInput(replay([{ type: 'text', text: 'x' }, { type: 'text', text: '[Workbench message wbm-1f]' }]) as ClaudeStreamMessage, true)).toBe('wbm-1f');
    expect(matchReplayedInput({ type: 'user', message: { content: 'x' } } as ClaudeStreamMessage, false)).toBeUndefined();
  });
});
