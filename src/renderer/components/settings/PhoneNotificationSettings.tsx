import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import type { AppSettings } from '../../../shared/types';
import type { NotificationKind } from '../../../shared/utils/notification-events';
import { resolvePhoneSettings } from '../../../shared/utils/phone-notify';

interface PhoneNotificationSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

const EVENT_ITEMS: NotificationKind[] = ['decision-needed', 'task-failed', 'queue-empty', 'task-complete', 'review-needed'];

const EVENT_KEYS: Record<NotificationKind, string> = {
  'decision-needed': 'decisionNeeded',
  'task-failed': 'needsAttention',
  'queue-empty': 'queueEmpty',
  'task-complete': 'taskMerged',
  'review-needed': 'reviewNeeded',
};

/** Settings > General > Notifications: push the same events to a phone through Home Assistant */
export function PhoneNotificationSettings({ settings, onSettingsChange }: PhoneNotificationSettingsProps) {
  const { t } = useTranslation('settings');
  const phone = resolvePhoneSettings(settings.phoneNotifications);
  const [hasToken, setHasToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.electronAPI.hasPhoneNotifyToken().then((result) => {
      if (result.success) setHasToken(!!result.data);
    });
  }, []);

  const update = (patch: Partial<typeof phone>) =>
    onSettingsChange({ ...settings, phoneNotifications: { ...phone, ...patch } });

  /** Saves the typed token; returns false (and says why) when it could not be stored */
  const saveToken = async (): Promise<boolean> => {
    if (!tokenDraft.trim()) return true;
    const result = await window.electronAPI.setPhoneNotifyToken(tokenDraft);
    if (!result.success) {
      setMessage(result.error ?? t('phoneNotifications.tokenFailed'));
      return false;
    }
    setTokenDraft('');
    setHasToken(true);
    return true;
  };

  const handleSaveToken = async () => {
    setBusy(true);
    setMessage(null);
    if (await saveToken()) setMessage(t('phoneNotifications.tokenSaved'));
    setBusy(false);
  };

  const handleClearToken = async () => {
    await window.electronAPI.setPhoneNotifyToken('');
    setHasToken(false);
    setMessage(null);
  };

  const handleTest = async () => {
    setBusy(true);
    setMessage(null);
    if (await saveToken()) {
      const result = await window.electronAPI.sendPhoneTestNotification({ baseUrl: phone.baseUrl, service: phone.service });
      setMessage(
        result.success
          ? t('phoneNotifications.testSent', { status: result.data?.status ?? 200 })
          : t('phoneNotifications.testFailed', { error: result.error ?? '' })
      );
    }
    setBusy(false);
  };

  return (
    <SettingsSection title={t('phoneNotifications.title')} description={t('phoneNotifications.description')}>
      <SettingsRows>
        <SettingsRow
          label={t('phoneNotifications.enabled')}
          description={t('phoneNotifications.enabledDescription')}
          htmlFor="phone-notify-enabled"
        >
          <Switch id="phone-notify-enabled" checked={phone.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        </SettingsRow>
        <SettingsRow label={t('phoneNotifications.baseUrl')} description={t('phoneNotifications.baseUrlDescription')} htmlFor="phone-notify-url">
          <Input
            id="phone-notify-url"
            className="w-72"
            value={phone.baseUrl}
            placeholder="http://beelink.local:8123"
            onChange={(e) => update({ baseUrl: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow label={t('phoneNotifications.service')} description={t('phoneNotifications.serviceDescription')} htmlFor="phone-notify-service">
          <Input
            id="phone-notify-service"
            className="w-72"
            value={phone.service}
            placeholder="mobile_app_ians_iphone"
            onChange={(e) => update({ service: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('phoneNotifications.token')}
          description={hasToken ? t('phoneNotifications.tokenSavedDescription') : t('phoneNotifications.tokenDescription')}
          htmlFor="phone-notify-token"
        >
          <Input
            id="phone-notify-token"
            type="password"
            autoComplete="off"
            className="w-56"
            value={tokenDraft}
            placeholder={hasToken ? '••••••••' : ''}
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <Button variant="outline" size="sm" disabled={busy || !tokenDraft.trim()} onClick={handleSaveToken}>
            {t('phoneNotifications.saveToken')}
          </Button>
          {hasToken && (
            <Button variant="outline" size="sm" disabled={busy} onClick={handleClearToken}>
              {t('phoneNotifications.removeToken')}
            </Button>
          )}
        </SettingsRow>
        {EVENT_ITEMS.map((kind) => (
          <SettingsRow
            key={kind}
            label={t(`phoneNotifications.events.${EVENT_KEYS[kind]}`)}
            htmlFor={`phone-notify-${kind}`}
          >
            <Switch
              id={`phone-notify-${kind}`}
              checked={phone.events[kind]}
              onCheckedChange={(checked) => update({ events: { ...phone.events, [kind]: checked } })}
            />
          </SettingsRow>
        ))}
        <SettingsRow label={t('phoneNotifications.test')} description={message ?? t('phoneNotifications.testDescription')}>
          <Button variant="outline" size="sm" disabled={busy} onClick={handleTest}>
            {t('phoneNotifications.testButton')}
          </Button>
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
