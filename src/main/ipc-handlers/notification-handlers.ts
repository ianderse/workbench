/**
 * Notification IPC handlers: the Home Assistant token (stored encrypted, never sent back to the
 * renderer) and the test notification for Settings > General > Notifications.
 */
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import { handleIpc } from './ipc-registry';
import { sendHaNotification } from '../phone-notifier';
import { hasHaToken, loadHaToken, saveHaToken } from '../phone-token-store';
import { appLog } from '../app-logger';
import { buildHaPayload } from '../../shared/utils/phone-notify';
import { startNotificationHooks } from '../attention-notifier';

export function registerNotificationHandlers(): void {
  startNotificationHooks();

  handleIpc(IPC_CHANNELS.PHONE_NOTIFY_SET_TOKEN, async (_, token: string): Promise<IPCResult> => {
    const result = saveHaToken(typeof token === 'string' ? token : '');
    return result.success ? { success: true } : { success: false, error: result.error };
  });

  handleIpc(IPC_CHANNELS.PHONE_NOTIFY_HAS_TOKEN, async (): Promise<IPCResult<boolean>> => ({
    success: true,
    data: hasHaToken(),
  }));

  handleIpc(
    IPC_CHANNELS.PHONE_NOTIFY_TEST,
    async (_, target: { baseUrl: string; service: string }): Promise<IPCResult<{ status?: number }>> => {
      const result = await sendHaNotification(
        { baseUrl: target?.baseUrl ?? '', service: target?.service ?? '', token: loadHaToken() },
        buildHaPayload({
          kind: 'queue-empty',
          title: 'Workbench test notification',
          body: 'Phone notifications are set up',
          route: { projectId: 'test', taskId: 'test' },
        })
      );
      if (!result.ok) {
        appLog.warn(`[PhoneNotify] Test notification failed: ${result.error ?? 'unknown error'}`);
        return { success: false, error: result.error ?? 'Unknown error' };
      }
      return { success: true, data: { status: result.status } };
    }
  );
}
