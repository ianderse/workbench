import { Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { readSettingsFile } from './settings-utils';
import { DEFAULT_APP_SETTINGS } from '../shared/constants';
import type { NotificationSettings } from '../shared/types';
import { IPC_CHANNELS } from '../shared/constants';
import type { NotificationContent, NotificationKind } from '../shared/utils/notification-events';
import { resolvePhoneSettings, routeNotification } from '../shared/utils/phone-notify';
import { notifyPhone } from './phone-notifier';
import { loadHaToken } from './phone-token-store';
import { appLog } from './app-logger';
import { findWindowForProject, showWindow } from './window-manager';

type NotificationType = NotificationKind;

interface NotificationOptions {
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
}

/** The same notification for the same task is shown once in this window (an error is reported by several paths) */
const DEDUPE_MS = 30_000;

/**
 * Service for sending system notifications with optional sound
 */
class NotificationService {
  private mainWindow: (() => BrowserWindow | null) | null = null;
  private readonly recent = new Map<string, number>();

  /**
   * Initialize the notification service with the main window getter
   */
  initialize(getMainWindow: () => BrowserWindow | null): void {
    this.mainWindow = getMainWindow;
  }

  /**
   * Send a notification for task completion
   */
  notifyTaskComplete(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-complete', {
      title: 'Task Complete',
      body: `"${taskTitle}" has completed and is ready for review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for task failure
   */
  notifyTaskFailed(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('task-failed', {
      title: 'Task Failed',
      body: `"${taskTitle}" encountered an error`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for review needed
   */
  notifyReviewNeeded(taskTitle: string, projectId: string, taskId: string): void {
    this.sendNotification('review-needed', {
      title: 'Review Needed',
      body: `"${taskTitle}" is ready for your review`,
      projectId,
      taskId
    });
  }

  /**
   * Send a notification built by `shared/utils/notification-events.ts`; clicking it opens its route
   */
  notifyContent(content: NotificationContent): void {
    this.sendNotification(content.kind, {
      title: content.title,
      body: content.body,
      projectId: content.route.projectId,
      taskId: content.route.taskId
    });
  }

  /**
   * Send a system notification with optional sound
   */
  private sendNotification(type: NotificationType, options: NotificationOptions): void {
    // Get notification settings
    const settings = this.getNotificationSettings();

    // The desktop switch and the phone switch are independent
    const phone = resolvePhoneSettings(readSettingsFile()?.phoneNotifications as never);
    const route = routeNotification(type, this.isNotificationEnabled(type, settings), phone);
    if (!route.desktop && !route.phone) return;
    if (this.isDuplicate(type, options)) return;

    if (route.phone) {
      const token = loadHaToken();
      void notifyPhone(
        { kind: type, title: options.title, body: options.body, route: { projectId: options.projectId ?? '', taskId: options.taskId } },
        { baseUrl: phone.baseUrl, service: phone.service, token }
      ).catch((error) => appLog.warn('[PhoneNotify] Unexpected failure:', error instanceof Error ? error.message : String(error)));
    }
    if (!route.desktop) return;

    // Create and show the notification
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: !settings.sound // Let the OS handle sound if enabled
      });

      // Show the window of the task's project when the notification is clicked (it may be
      // minimized or hidden to the tray) and open the task, or the project's board
      notification.on('click', () => {
        const window =
          (options.projectId ? findWindowForProject(options.projectId) : null) ?? this.mainWindow?.();
        if (!window) return;
        showWindow(window);
        if (options.projectId && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.NOTIFICATION_OPEN, {
            projectId: options.projectId,
            taskId: options.taskId
          });
        }
      });

      notification.show();
    }

    // Play sound if enabled (system beep)
    if (settings.sound) {
      this.playNotificationSound();
    }
  }

  private isDuplicate(type: NotificationType, options: NotificationOptions): boolean {
    if (!options.taskId) return false;
    const now = Date.now();
    for (const [key, at] of this.recent) if (now - at > DEDUPE_MS) this.recent.delete(key);
    const key = `${type}\0${options.projectId ?? ''}\0${options.taskId}`;
    if (this.recent.has(key)) return true;
    this.recent.set(key, now);
    return false;
  }

  /**
   * Play a notification sound
   */
  private playNotificationSound(): void {
    // Use system beep - works across all platforms
    shell.beep();
  }

  /**
   * Get the app-wide notification settings (Settings > General > Notifications),
   * falling back to the defaults for any missing value
   */
  private getNotificationSettings(): NotificationSettings {
    const saved = readSettingsFile()?.notifications as Partial<NotificationSettings> | undefined;
    return { ...DEFAULT_APP_SETTINGS.notifications, ...saved };
  }

  /**
   * Check if a notification type is enabled in settings
   */
  private isNotificationEnabled(
    type: NotificationType,
    settings: NotificationSettings
  ): boolean {
    switch (type) {
      case 'task-complete':
        return settings.onTaskComplete;
      case 'task-failed':
        return settings.onTaskFailed;
      case 'review-needed':
        return settings.onReviewNeeded;
      case 'decision-needed':
        return settings.onDecisionNeeded;
      case 'queue-empty':
        return settings.onQueueEmpty;
      default:
        return false;
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
