/**
 * Windows shell IPC handlers (Settings > General): the shell runtime's status, checking WSL
 * availability again, and restarting the app so a changed setting applies
 */

import { app, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult, ShellRuntimeStatus } from '../../shared/types';
import { appLog } from '../app-logger';
import { getShellRuntimeStatus, refreshWslAvailability } from '../platform/shell-runtime';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerShellRuntimeHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SHELL_RUNTIME_GET_STATUS, (): IPCResult<ShellRuntimeStatus> => {
    return { success: true, data: getShellRuntimeStatus() };
  });

  ipcMain.handle(IPC_CHANNELS.SHELL_RUNTIME_REFRESH_WSL, async (): Promise<IPCResult<ShellRuntimeStatus>> => {
    try {
      return { success: true, data: await refreshWslAvailability() };
    } catch (error) {
      appLog.error('[ShellRuntime] WSL check failed:', error);
      return { success: false, error: errorMessage(error) };
    }
  });

  // Relaunch, then quit through app.quit() so the before-quit cleanup (agents, terminals) runs
  ipcMain.handle(IPC_CHANNELS.APP_RELAUNCH, (): IPCResult => {
    app.relaunch();
    app.quit();
    return { success: true };
  });
}
