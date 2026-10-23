/// <reference types="electron-vite/node" />
/**
 * Starts the relay worker thread. electron-vite bundles relay-worker.ts as its
 * own chunk (the `?nodeWorker` import) and returns a factory for it.
 */
import type { Worker } from 'worker_threads';
import createWorker from './relay-worker?nodeWorker';
import type { RelayWorkerData } from './relay-worker-protocol';

/** `data`: what the worker needs from the main thread to start (it can't read the shell runtime itself) */
export function createRelayWorker(data: RelayWorkerData = { wsl: null }): Worker {
  return createWorker({ workerData: data });
}
