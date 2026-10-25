/**
 * Sends a notification to the phone through Home Assistant's `notify` service. The access token
 * is a secret: it is kept encrypted with safeStorage (phone-token-store.ts), sent only in the
 * Authorization header, and never logged. Never throws.
 */
import { appLog } from './app-logger';
import {
  buildHaPayload,
  normalizeBaseUrl,
  normalizeService,
  type HaNotifyPayload,
} from '../shared/utils/phone-notify';
import type { NotificationContent } from '../shared/utils/notification-events';

const TIMEOUT_MS = 10_000;

export interface PhoneSendResult {
  ok: boolean;
  /** HTTP status when the server answered */
  status?: number;
  error?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; statusText?: string }>;

export async function sendHaNotification(
  target: { baseUrl: string; service: string; token: string },
  payload: HaNotifyPayload,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<PhoneSendResult> {
  const baseUrl = normalizeBaseUrl(target.baseUrl);
  const service = normalizeService(target.service);
  if (!baseUrl) return { ok: false, error: 'Home Assistant URL must start with http:// or https://' };
  if (!service) return { ok: false, error: 'Notify service may only contain letters, numbers and underscores' };
  if (!target.token) return { ok: false, error: 'No access token saved' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/api/services/notify/${service}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true, status: response.status };
    return {
      ok: false,
      status: response.status,
      error: `Home Assistant answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: `No answer within ${TIMEOUT_MS / 1000} seconds` };
    // fetch errors name the URL at most, never the Authorization header
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Send a notification event to the phone; failures are logged (without the token) and swallowed */
export async function notifyPhone(
  content: NotificationContent,
  target: { baseUrl: string; service: string; token: string },
  fetchImpl?: FetchLike
): Promise<PhoneSendResult> {
  const result = await sendHaNotification(target, buildHaPayload(content), fetchImpl);
  if (!result.ok) appLog.warn(`[PhoneNotify] Could not send "${content.title}": ${result.error ?? 'unknown error'}`);
  return result;
}
