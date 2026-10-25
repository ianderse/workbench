import { describe, expect, it, vi } from 'vitest';

vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { notifyPhone, sendHaNotification } from '../phone-notifier';
import {
  buildHaPayload,
  normalizeBaseUrl,
  normalizeService,
  resolvePhoneSettings,
  routeNotification,
} from '../../shared/utils/phone-notify';
import type { NotificationContent } from '../../shared/utils/notification-events';

const content: NotificationContent = {
  kind: 'decision-needed',
  title: 'Decision needed: X',
  body: 'waiting',
  route: { projectId: 'p1', taskId: 't1' },
};
const target = { baseUrl: 'http://beelink.local:8123/', service: 'notify.mobile_app_phone', token: 'SECRET' };

describe('phone payload and settings', () => {
  it('builds the Home Assistant body with group and a per-task tag', () => {
    expect(buildHaPayload(content)).toEqual({
      title: 'Decision needed: X',
      message: 'waiting',
      data: { group: 'workbench', tag: 'workbench-decision-needed-t1' },
    });
    const board = buildHaPayload({ ...content, kind: 'queue-empty', route: { projectId: 'p1' } });
    expect(board.data.tag).toBe('workbench-queue-empty-p1');
  });

  it('normalizes the URL and service', () => {
    expect(normalizeBaseUrl(' http://a:8123/ ')).toBe('http://a:8123');
    expect(normalizeBaseUrl('ftp://a')).toBeNull();
    expect(normalizeBaseUrl('nonsense')).toBeNull();
    expect(normalizeService('notify.mobile_app_x')).toBe('mobile_app_x');
    expect(normalizeService('bad/../path')).toBeNull();
  });

  it('defaults the phone events to decision, attention and all done, merged off', () => {
    const phone = resolvePhoneSettings({ enabled: true });
    expect(phone.events).toMatchObject({
      'decision-needed': true,
      'task-failed': true,
      'queue-empty': true,
      'task-complete': false,
    });
  });

  it('routes desktop and phone independently', () => {
    const on = resolvePhoneSettings({ enabled: true });
    expect(routeNotification('task-complete', true, on)).toEqual({ desktop: true, phone: false });
    expect(routeNotification('queue-empty', false, on)).toEqual({ desktop: false, phone: true });
    expect(routeNotification('queue-empty', true, resolvePhoneSettings())).toEqual({ desktop: true, phone: false });
  });
});

describe('sendHaNotification', () => {
  it('posts to the notify service with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await sendHaNotification(target, buildHaPayload(content), fetchMock);
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://beelink.local:8123/api/services/notify/mobile_app_phone');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer SECRET');
    expect(JSON.parse(init.body).data.group).toBe('workbench');
  });

  it('reports an HTTP failure without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const result = await sendHaNotification(target, buildHaPayload(content), fetchMock);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.error).toContain('401');
  });

  it('reports a network error and rejects bad input before sending', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await sendHaNotification(target, buildHaPayload(content), failing)).error).toBe('ECONNREFUSED');
    const never = vi.fn();
    expect((await sendHaNotification({ ...target, baseUrl: 'x' }, buildHaPayload(content), never)).ok).toBe(false);
    expect((await sendHaNotification({ ...target, token: '' }, buildHaPayload(content), never)).ok).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it('does not put the token in logged or returned errors', async () => {
    const { appLog } = await import('../app-logger');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await notifyPhone(content, target, fetchMock);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify((appLog.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('SECRET');
  });
});
