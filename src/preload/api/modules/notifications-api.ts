/** Notification API for the renderer: phone (Home Assistant) setup and the click-to-open event */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import { createIpcListener, invokeIpc } from './ipc-utils';

export interface NotificationsAPI {
  setPhoneNotifyToken: (token: string) => Promise<IPCResult>;
  hasPhoneNotifyToken: () => Promise<IPCResult<boolean>>;
  sendPhoneTestNotification: (target: { baseUrl: string; service: string }) => Promise<IPCResult<{ status?: number }>>;
  onNotificationOpen: (callback: (target: { projectId: string; taskId?: string; memoryReview?: boolean }) => void) => () => void;
}

export const createNotificationsAPI = (): NotificationsAPI => ({
  setPhoneNotifyToken: (token) => invokeIpc(IPC_CHANNELS.PHONE_NOTIFY_SET_TOKEN, token),
  hasPhoneNotifyToken: () => invokeIpc(IPC_CHANNELS.PHONE_NOTIFY_HAS_TOKEN),
  sendPhoneTestNotification: (target) => invokeIpc(IPC_CHANNELS.PHONE_NOTIFY_TEST, target),
  onNotificationOpen: (callback) => createIpcListener(IPC_CHANNELS.NOTIFICATION_OPEN, callback),
});
