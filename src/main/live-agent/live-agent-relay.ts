/**
 * Live agent relay: runs agent-flow's relay (./relay) in a worker thread while the "Live agent"
 * setting is on, and passes its messages to the agent windows' graphs.
 *
 * The worker starts when the setting is switched on (or at startup when it is saved on) and keeps
 * running until the setting is switched off or the app quits. Agent windows only subscribe and
 * unsubscribe: opening or closing them never starts, stops or restarts it.
 */

import os from 'os';
import path from 'path';
import { BrowserWindow, type WebContents } from 'electron';
import type { Worker } from 'worker_threads';
import { IPC_CHANNELS } from '../../shared/constants';
import type { LiveAgentStatus } from '../../shared/types';
import { appLog } from '../app-logger';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { expandHomePath } from '../claude-profile/profile-utils';
import { createRelayWorker } from './create-relay-worker';
import type { RelayWorkerMessage, RelayWorkerRequest } from './relay-worker-protocol';

/** How long the worker gets to clean up (discovery files, hook server, watchers) before it is terminated */
const STOP_TIMEOUT_MS = 2000;

/** A graph in an agent window, shown sessions run in `cwd` */
interface Subscription {
  webContents: WebContents;
  contentsId: number;
  clientId: string;
  cwd: string;
}

/**
 * Claude Code config directories whose session transcripts are watched: the default one
 * (~/.claude) and each Claude profile's own (agent windows run with CLAUDE_CONFIG_DIR set to it)
 */
function getClaudeConfigDirs(): string[] {
  const dirs = [path.join(os.homedir(), '.claude')];
  try {
    for (const profile of getClaudeProfileManager().getSettings().profiles) {
      if (profile.configDir) dirs.push(path.resolve(expandHomePath(profile.configDir)));
    }
  } catch (error) {
    appLog.warn('[LiveAgent] Could not read the Claude profiles:', error);
  }
  return [...new Set(dirs)];
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class LiveAgentRelay {
  private worker: Worker | null = null;
  /** A worker that was asked to stop and has not exited yet */
  private stopping: Promise<void> | null = null;
  private stoppingWorker: Worker | null = null;
  private enabled = false;
  /** The app is quitting: nothing starts again */
  private shutDown = false;
  private status: LiveAgentStatus = { state: 'stopped' };
  /** Graphs by key (`<webContents id>:<client id>`, the client id the worker knows) */
  private subscriptions = new Map<string, Subscription>();
  /** webContents whose destruction or reload drops their subscriptions */
  private trackedContents = new Set<number>();

  getStatus(): LiveAgentStatus {
    return this.status;
  }

  /** Follow the "Live agent" setting: start the relay (once) or stop it */
  setEnabled(enabled: boolean): void {
    if (this.shutDown) return;
    this.enabled = enabled;
    if (enabled) this.start();
    else void this.stopWorker();
  }

  /** A graph in an agent window wants the sessions run in `cwd` */
  subscribe(webContents: WebContents, clientId: string, cwd: string): void {
    const contentsId = webContents.id;
    const key = `${contentsId}:${clientId}`;
    this.subscriptions.set(key, { webContents, contentsId, clientId, cwd });
    if (!this.trackedContents.has(contentsId)) {
      this.trackedContents.add(contentsId);
      const drop = () => {
        for (const [subscriptionKey, subscription] of this.subscriptions) {
          if (subscription.contentsId === contentsId) this.removeSubscription(subscriptionKey);
        }
      };
      webContents.once('destroyed', () => {
        this.trackedContents.delete(contentsId);
        drop();
      });
      // A reload unmounts the graphs without unsubscribing
      webContents.on('did-start-loading', drop);
    }
    this.post({ type: 'subscribe', clientId: key, cwd, claudeDirs: getClaudeConfigDirs() });
  }

  unsubscribe(webContents: WebContents, clientId: string): void {
    this.removeSubscription(`${webContents.id}:${clientId}`);
  }

  /** Stop the relay for good (the app is quitting); resolves once the worker is gone */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    this.enabled = false;
    await this.stopWorker();
  }

  /** Last resort while the app quits: terminate any worker still running */
  terminateNow(): void {
    this.shutDown = true;
    this.enabled = false;
    for (const worker of [this.worker, this.stoppingWorker]) {
      if (worker) void worker.terminate().catch(() => undefined);
    }
    this.worker = null;
    this.stoppingWorker = null;
  }

  private removeSubscription(key: string): void {
    if (!this.subscriptions.delete(key)) return;
    this.post({ type: 'unsubscribe', clientId: key });
  }

  private post(request: RelayWorkerRequest): void {
    try {
      this.worker?.postMessage(request);
    } catch (error) {
      appLog.error('[LiveAgent] Could not reach the relay:', error);
    }
  }

  private start(): void {
    if (this.worker) return;
    this.setStatus({ state: 'starting' });
    // A worker still cleaning up first finishes (it removes the discovery files the new one writes)
    if (this.stopping) {
      void this.stopping.then(() => {
        if (this.enabled && !this.shutDown && !this.worker) this.start();
      });
      return;
    }

    let worker: Worker;
    try {
      worker = createRelayWorker();
    } catch (error) {
      appLog.error('[LiveAgent] Could not start the relay:', error);
      this.setStatus({ state: 'error', error: errorMessage(error) });
      return;
    }
    this.worker = worker;
    worker.on('message', (message: RelayWorkerMessage) => this.onMessage(worker, message));
    worker.on('error', (error) => {
      if (this.worker !== worker) return;
      appLog.error('[LiveAgent] The relay failed:', error);
      this.worker = null;
      this.setStatus({ state: 'error', error: errorMessage(error) });
      void worker.terminate().catch(() => undefined);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      appLog.error(`[LiveAgent] The relay stopped unexpectedly (exit code ${code})`);
      this.worker = null;
      this.setStatus({ state: 'error', error: `exit code ${code}` });
    });

    const claudeDirs = getClaudeConfigDirs();
    this.post({ type: 'start', claudeDirs });
    for (const [key, subscription] of this.subscriptions) {
      this.post({ type: 'subscribe', clientId: key, cwd: subscription.cwd, claudeDirs });
    }
  }

  private onMessage(worker: Worker, message: RelayWorkerMessage): void {
    if (this.worker !== worker) return;
    switch (message.type) {
      case 'ready':
        this.setStatus({ state: 'running' });
        break;
      case 'error':
        appLog.error('[LiveAgent] The relay could not start:', message.error);
        this.worker = null;
        this.setStatus({ state: 'error', error: message.error });
        void worker.terminate().catch(() => undefined);
        break;
      case 'message':
        for (const key of message.clientIds) {
          const subscription = this.subscriptions.get(key);
          if (!subscription || subscription.webContents.isDestroyed()) continue;
          subscription.webContents.send(IPC_CHANNELS.LIVE_AGENT_MESSAGE, subscription.clientId, message.data);
        }
        break;
      case 'log':
        if (message.level === 'error') appLog.error(message.message);
        else if (message.level === 'warn') appLog.warn(message.message);
        else appLog.debug(message.message);
        break;
    }
  }

  /** Ask the worker to clean up and exit; terminated if it takes too long */
  private stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped' });
    if (!worker) return this.stopping ?? Promise.resolve();

    this.stoppingWorker = worker;
    const stopped = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', finish);
        worker.terminate().catch(() => undefined).then(() => resolve());
      };
      const onMessage = (message: RelayWorkerMessage) => {
        if (message?.type === 'stopped') finish();
      };
      const timer = setTimeout(finish, STOP_TIMEOUT_MS);
      worker.on('message', onMessage);
      worker.on('exit', finish);
      try {
        worker.postMessage({ type: 'stop' } satisfies RelayWorkerRequest);
      } catch {
        finish();
      }
    });
    const stopping: Promise<void> = stopped.then(() => {
      if (this.stoppingWorker === worker) this.stoppingWorker = null;
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  private setStatus(status: LiveAgentStatus): void {
    this.status = status;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.LIVE_AGENT_STATUS, status);
    }
  }
}

export const liveAgentRelay = new LiveAgentRelay();
