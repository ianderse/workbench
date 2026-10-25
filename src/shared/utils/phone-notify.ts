/**
 * Phone notifications through Home Assistant: the settings shape, which events go where and the
 * request the Home Assistant `notify` service receives. Pure; `main/phone-notifier.ts` sends it.
 */
import type { NotificationContent, NotificationKind } from './notification-events';

export interface PhoneNotificationSettings {
  enabled: boolean;
  /** Home Assistant base URL, e.g. http://beelink.local:8123 */
  baseUrl: string;
  /** The part after `notify.`, e.g. mobile_app_ians_iphone */
  service: string;
  /** Events sent to the phone */
  events: Record<NotificationKind, boolean>;
}

export const DEFAULT_PHONE_NOTIFICATIONS: PhoneNotificationSettings = {
  enabled: false,
  baseUrl: '',
  service: '',
  events: {
    'decision-needed': true,
    'task-failed': true,
    'queue-empty': true,
    'task-complete': false,
    'review-needed': false,
  },
};

/** Saved settings (possibly missing values) on top of the defaults */
export function resolvePhoneSettings(saved?: Partial<PhoneNotificationSettings> | null): PhoneNotificationSettings {
  return {
    ...DEFAULT_PHONE_NOTIFICATIONS,
    ...saved,
    events: { ...DEFAULT_PHONE_NOTIFICATIONS.events, ...saved?.events },
  };
}

/** Which channels get a notification of `kind` (the desktop switch and the phone switch are independent) */
export function routeNotification(
  kind: NotificationKind,
  desktopEnabled: boolean,
  phone: PhoneNotificationSettings
): { desktop: boolean; phone: boolean } {
  return { desktop: desktopEnabled, phone: phone.enabled && phone.events[kind] === true };
}

/** `http://host:8123/` becomes `http://host:8123`; null when it is not an http(s) URL */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return null;
  }
}

/** `notify.mobile_app_x` and `mobile_app_x` are both accepted; null when not a service name */
export function normalizeService(raw: string): string | null {
  const name = raw.trim().replace(/^notify\./, '');
  return /^[A-Za-z0-9_]+$/.test(name) ? name : null;
}

export interface HaNotifyPayload {
  title: string;
  message: string;
  data: { group: string; tag: string };
}

/**
 * The body for POST /api/services/notify/<service>. `group` and `tag` work on iOS and Android
 * (a later notification with the same tag replaces the earlier one). No `url`: the companion apps
 * use different fields for it (`url` on iOS, `clickAction` on Android) and there is no deep link.
 */
export function buildHaPayload(content: NotificationContent): HaNotifyPayload {
  return {
    title: content.title,
    message: content.body,
    data: { group: 'workbench', tag: `workbench-${content.kind}-${content.route.taskId ?? content.route.projectId}` },
  };
}
