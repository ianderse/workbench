/// <reference types="electron-vite/node" />
/**
 * Starts the relay worker thread. electron-vite bundles relay-worker.ts as its
 * own chunk (the `?nodeWorker` import) and returns a factory for it.
 */
import type { Worker } from 'worker_threads';
import createWorker from './relay-worker?nodeWorker';

export function createRelayWorker(): Worker {
  return createWorker({});
}
