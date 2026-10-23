import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult, ShellRuntimeStatus } from '../../../shared/types';
import { invokeIpc } from './ipc-utils';

/** Windows shell setting (Settings > General) */
export interface ShellRuntimeAPI {
  /** The value the app started with, the one it runs with, and the last WSL availability check */
  getShellRuntimeStatus: () => Promise<IPCResult<ShellRuntimeStatus>>;
  /** Check WSL availability again */
  refreshWslAvailability: () => Promise<IPCResult<ShellRuntimeStatus>>;
  /** Restart the app (applies a changed shell setting) */
  relaunchApp: () => Promise<IPCResult>;
}

export const createShellRuntimeAPI = (): ShellRuntimeAPI => ({
  getShellRuntimeStatus: (): Promise<IPCResult<ShellRuntimeStatus>> =>
    invokeIpc(IPC_CHANNELS.SHELL_RUNTIME_GET_STATUS),

  refreshWslAvailability: (): Promise<IPCResult<ShellRuntimeStatus>> =>
    invokeIpc(IPC_CHANNELS.SHELL_RUNTIME_REFRESH_WSL),

  relaunchApp: (): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.APP_RELAUNCH)
});
