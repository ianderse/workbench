/**
 * Live agent relay lifecycle: the worker runs only while the setting is on, is started once,
 * isn't restarted by agent windows subscribing or going away, and is stopped when the app quits
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker extends EventEmitter {
  posted: Array<{ type: string; [key: string]: unknown }> = [];
  terminated = false;
  /** Reply to `stop` like the real worker */
  answersStop = true;

  postMessage(message: { type: string }) {
    this.posted.push(message);
    if (message.type === 'stop' && this.answersStop) queueMicrotask(() => this.emit('message', { type: 'stopped' }));
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve(1);
  }
}

const workers: FakeWorker[] = [];
const windowSend = vi.fn();

vi.mock('../create-relay-worker', () => ({
  createRelayWorker: vi.fn(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: windowSend } }],
  },
}));

vi.mock('../../app-logger', () => ({
  appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ getSettings: () => ({ profiles: [{ configDir: '/tmp/claude-work' }] }) }),
}));

import { LiveAgentRelay } from '../live-agent-relay';

/** A window's webContents, enough for subscriptions */
function fakeContents(id: number) {
  const events = new EventEmitter();
  return Object.assign(events, {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
  });
}

type Contents = ReturnType<typeof fakeContents>;
const asContents = (contents: Contents) => contents as unknown as Electron.WebContents;

describe('LiveAgentRelay', () => {
  let relay: LiveAgentRelay;

  beforeEach(() => {
    workers.length = 0;
    windowSend.mockClear();
    relay = new LiveAgentRelay();
  });

  it('starts no worker while the setting is off, even when agent windows subscribe', () => {
    relay.subscribe(asContents(fakeContents(1)), 'graph-1', '/projects/app');
    relay.setEnabled(false);
    expect(workers).toHaveLength(0);
    expect(relay.getStatus().state).toBe('stopped');
  });

  it('starts one worker when switched on, and switching on again keeps it', () => {
    relay.setEnabled(true);
    relay.setEnabled(true);
    expect(workers).toHaveLength(1);
    expect(workers[0].posted[0]).toMatchObject({ type: 'start' });
    expect(workers[0].posted[0].claudeDirs).toContain('/tmp/claude-work');
    expect(relay.getStatus().state).toBe('starting');

    workers[0].emit('message', { type: 'ready' });
    expect(relay.getStatus().state).toBe('running');
    expect(windowSend).toHaveBeenLastCalledWith('liveAgent:status', { state: 'running' });
  });

  it('is not restarted by agent windows opening, closing or reloading', () => {
    relay.setEnabled(true);
    const contents = fakeContents(7);
    relay.subscribe(asContents(contents), 'graph-1', '/projects/app');
    relay.subscribe(asContents(contents), 'graph-2', '/projects/app/.auto-claude/worktrees/tasks/001');
    relay.unsubscribe(asContents(contents), 'graph-1');
    contents.emit('did-start-loading');
    contents.emit('destroyed');

    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].posted.map((message) => message.type)).toEqual([
      'start', 'subscribe', 'subscribe', 'unsubscribe', 'unsubscribe',
    ]);
    expect(workers[0].posted[1]).toMatchObject({ clientId: '7:graph-1', cwd: '/projects/app' });
  });

  it('sends a graph only the messages meant for it', () => {
    relay.setEnabled(true);
    const first = fakeContents(1);
    const second = fakeContents(2);
    relay.subscribe(asContents(first), 'a', '/projects/one');
    relay.subscribe(asContents(second), 'b', '/projects/two');

    workers[0].emit('message', { type: 'message', clientIds: ['1:a'], data: '{"type":"session-list"}' });
    expect(first.send).toHaveBeenCalledWith('liveAgent:message', 'a', '{"type":"session-list"}');
    expect(second.send).not.toHaveBeenCalled();
  });

  it('subscriptions made before the relay starts reach the new worker', () => {
    relay.subscribe(asContents(fakeContents(3)), 'graph', '/projects/app');
    relay.setEnabled(true);
    expect(workers[0].posted.map((message) => message.type)).toEqual(['start', 'subscribe']);
  });

  it('stops the worker when the setting is switched off', async () => {
    relay.setEnabled(true);
    relay.setEnabled(false);
    expect(workers[0].posted.at(-1)).toEqual({ type: 'stop' });
    await vi.waitFor(() => expect(workers[0].terminated).toBe(true));
    expect(relay.getStatus().state).toBe('stopped');
  });

  it('stops the worker on quit and never starts it again', async () => {
    relay.setEnabled(true);
    await relay.shutdown();
    expect(workers[0].posted.at(-1)).toEqual({ type: 'stop' });
    expect(workers[0].terminated).toBe(true);

    relay.setEnabled(true);
    expect(workers).toHaveLength(1);
  });

  it('terminates a worker that does not answer stop in time', async () => {
    vi.useFakeTimers();
    try {
      relay.setEnabled(true);
      workers[0].answersStop = false;
      const done = relay.shutdown();
      expect(workers[0].terminated).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      expect(workers[0].terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminateNow ends a running worker at once', () => {
    relay.setEnabled(true);
    relay.terminateNow();
    expect(workers[0].terminated).toBe(true);
  });

  it('reports a start failure as a status without throwing', () => {
    relay.setEnabled(true);
    expect(() => workers[0].emit('message', { type: 'error', error: 'listen EACCES' })).not.toThrow();
    expect(relay.getStatus()).toEqual({ state: 'error', error: 'listen EACCES' });
    expect(workers[0].terminated).toBe(true);

    // Switching it on again tries again with a new worker
    relay.setEnabled(true);
    expect(workers).toHaveLength(2);
  });

  it('reports a crashed worker as a status without throwing', () => {
    relay.setEnabled(true);
    expect(() => workers[0].emit('error', new Error('boom'))).not.toThrow();
    expect(relay.getStatus()).toEqual({ state: 'error', error: 'boom' });
  });
});
