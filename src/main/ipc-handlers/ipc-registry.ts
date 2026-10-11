/**
 * IPC handlers that the main process can call too: the Claude chat's task tools use the same
 * handlers as the UI, so they follow the same rules (and update the board the same way).
 */
import { ipcMain } from 'electron';

type IpcListener = (event: any, ...args: any[]) => unknown;

const listeners = new Map<string, IpcListener>();

/** `ipcMain.handle` that also keeps the handler for `invokeIpcHandler` */
export function handleIpc(channel: string, listener: IpcListener): void {
  listeners.set(channel, listener);
  ipcMain.handle(channel, listener);
}

/** `ipcMain.on` that also keeps the listener for `invokeIpcHandler` */
export function onIpc(channel: string, listener: IpcListener): void {
  listeners.set(channel, listener);
  ipcMain.on(channel, listener);
}

/** Call a registered IPC handler from the main process, as if the renderer invoked it */
export async function invokeIpcHandler<T>(channel: string, ...args: unknown[]): Promise<T> {
  const listener = listeners.get(channel);
  if (!listener) throw new Error(`No IPC handler registered for ${channel}`);
  return (await listener({ sender: null }, ...args)) as T;
}
