import { EventEmitter } from 'events';

/** Emitted only after a complete ledger write. No Electron dependency in the storage layer. */
export const memoryEvents = new EventEmitter();
export function memoryChanged(dir: string, projectId: string): void {
  // A failed notification or UI listener must never turn a durable write into a failed mutation.
  for (const listener of memoryEvents.listeners('changed')) {
    try { Promise.resolve(listener({ dir, projectId })).catch(() => undefined); } catch { /* isolated observers */ }
  }
}
