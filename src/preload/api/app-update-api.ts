import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AppUpdateCheckResult,
  AppUpdateInfo,
  AppUpdateProgress,
  AppUpdateDownloadedEvent,
  AppUpdateErrorEvent,
  IPCResult
} from '../../shared/types';
import { createIpcListener, invokeIpc, IpcListenerCleanup } from './modules/ipc-utils';

/**
 * App Auto-Update API operations
 * Handles Electron app updates using electron-updater
 */
export interface AppUpdateAPI {
  // Operations
  checkAppUpdate: () => Promise<IPCResult<AppUpdateCheckResult>>;
  downloadAppUpdate: () => Promise<IPCResult>;
  downloadStableUpdate: () => Promise<IPCResult>;
  installAppUpdate: () => void;
  getAppVersion: () => Promise<string>;
  getDownloadedAppUpdate: () => Promise<IPCResult<AppUpdateInfo | null>>;
  /** The last check's result in the main process (e.g. the launch check's), null before one */
  getLastAppUpdateCheck: () => Promise<IPCResult<AppUpdateCheckResult | null>>;
  /** Match the Windows/Linux window controls to the theme (hex colors) */
  setTitleBarColors: (colors: { color: string; symbolColor: string }) => void;

  // Event Listeners
  /** A check finished (at launch, periodic, after Beta updates changed, or asked for) */
  onAppUpdateChecked: (
    callback: (result: AppUpdateCheckResult) => void
  ) => IpcListenerCleanup;
  onAppUpdateDownloaded: (
    callback: (info: AppUpdateDownloadedEvent) => void
  ) => IpcListenerCleanup;
  onAppUpdateProgress: (
    callback: (progress: AppUpdateProgress) => void
  ) => IpcListenerCleanup;
  onAppUpdateReadOnlyVolume: (
    callback: (info: { appPath: string }) => void
  ) => IpcListenerCleanup;
  onAppUpdateError: (
    callback: (error: AppUpdateErrorEvent) => void
  ) => IpcListenerCleanup;
  /** A new version was found, or its notification clicked: open Settings > Updates */
  onAppUpdateOpenSettings: (callback: () => void) => IpcListenerCleanup;
}

/**
 * Creates the App Auto-Update API implementation
 */
export const createAppUpdateAPI = (): AppUpdateAPI => ({
  // Operations
  checkAppUpdate: (): Promise<IPCResult<AppUpdateCheckResult>> =>
    invokeIpc(IPC_CHANNELS.APP_UPDATE_CHECK),

  downloadAppUpdate: (): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.APP_UPDATE_DOWNLOAD),

  downloadStableUpdate: (): Promise<IPCResult> =>
    invokeIpc(IPC_CHANNELS.APP_UPDATE_DOWNLOAD_STABLE),

  installAppUpdate: (): void => {
    invokeIpc(IPC_CHANNELS.APP_UPDATE_INSTALL).catch((err) =>
      console.error('[app-update] Install failed:', err)
    );
  },

  getAppVersion: (): Promise<string> =>
    invokeIpc(IPC_CHANNELS.APP_UPDATE_GET_VERSION),

  getDownloadedAppUpdate: (): Promise<IPCResult<AppUpdateInfo | null>> =>
    invokeIpc(IPC_CHANNELS.APP_UPDATE_GET_DOWNLOADED),

  getLastAppUpdateCheck: (): Promise<IPCResult<AppUpdateCheckResult | null>> =>
    invokeIpc(IPC_CHANNELS.APP_UPDATE_GET_LAST_CHECK),

  setTitleBarColors: (colors: { color: string; symbolColor: string }): void =>
    ipcRenderer.send(IPC_CHANNELS.WINDOW_SET_TITLE_BAR_COLORS, colors),

  // Event Listeners
  onAppUpdateChecked: (
    callback: (result: AppUpdateCheckResult) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.APP_UPDATE_CHECKED, callback),

  onAppUpdateDownloaded: (
    callback: (info: AppUpdateDownloadedEvent) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, callback),

  onAppUpdateProgress: (
    callback: (progress: AppUpdateProgress) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.APP_UPDATE_PROGRESS, callback),

  onAppUpdateReadOnlyVolume: (
    callback: (info: { appPath: string }) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.APP_UPDATE_READONLY_VOLUME, callback),

  onAppUpdateError: (
    callback: (error: AppUpdateErrorEvent) => void
  ): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.APP_UPDATE_ERROR, callback),

  onAppUpdateOpenSettings: (callback: () => void): IpcListenerCleanup =>
    createIpcListener(IPC_CHANNELS.APP_UPDATE_OPEN_SETTINGS, callback)
});
