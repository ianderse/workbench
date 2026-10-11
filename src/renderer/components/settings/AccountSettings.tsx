/**
 * AccountSettings - how Claude Code signs in
 *
 * claude.ai settings layout: Claude accounts (subscriptions, with usage), API profiles
 * (Anthropic-compatible endpoints), spending per project (Metrics) and automatic account
 * switching.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { ClaudeAccountsSection } from './ClaudeAccountsSection';
import { ProfileList } from './ProfileList';
import { ProjectMetricsSection } from './ProjectMetricsSection';
import { useClaudeAccounts } from './hooks/useClaudeAccounts';
import type { AppSettings, ClaudeAutoSwitchSettings } from '../../../shared/types';

interface AccountSettingsProps {
  /** Kept for the page signature; accounts are stored by the main process, not in app settings */
  settings?: AppSettings;
  onSettingsChange?: (settings: AppSettings) => void;
  isOpen: boolean;
}

export function AccountSettings({ isOpen }: AccountSettingsProps) {
  const { t } = useTranslation('settings');
  const { profiles } = useClaudeAccounts(isOpen);

  const [autoSwitchSettings, setAutoSwitchSettings] = useState<ClaudeAutoSwitchSettings | null>(null);
  const [isLoadingAutoSwitch, setIsLoadingAutoSwitch] = useState(false);
  // A failed settings change, shown at the top of the switching section
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const showUpdateFailed = useCallback((description?: string) => {
    setSettingsError(`${t('accounts.toast.settingsUpdateFailed')}: ${description || t('accounts.toast.tryAgain')}`);
  }, [t]);

  const loadAutoSwitchSettings = useCallback(async () => {
    setIsLoadingAutoSwitch(true);
    try {
      const result = await window.electronAPI.getAutoSwitchSettings();
      if (result.success && result.data) setAutoSwitchSettings(result.data);
    } catch {
      // Non-fatal
    } finally {
      setIsLoadingAutoSwitch(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadAutoSwitchSettings();
  }, [isOpen, loadAutoSwitchSettings]);

  const handleUpdateAutoSwitch = async (updates: Partial<ClaudeAutoSwitchSettings>) => {
    setIsLoadingAutoSwitch(true);
    setSettingsError(null);
    try {
      const result = await window.electronAPI.updateAutoSwitchSettings(updates);
      if (result.success) {
        await loadAutoSwitchSettings();
      } else {
        showUpdateFailed(result.error);
      }
    } catch {
      showUpdateFailed();
    } finally {
      setIsLoadingAutoSwitch(false);
    }
  };

  const totalAccounts = profiles.length;

  const thresholdSlider = (
    id: string,
    value: number,
    onChange: (value: number) => void,
    describedBy: string
  ) => (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min="0"
        max="99"
        step="1"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        disabled={isLoadingAutoSwitch}
        aria-describedby={describedBy}
        className={cn(
          'h-1.5 w-40 cursor-pointer appearance-none rounded-full bg-segment-track disabled:cursor-default',
          'focus-visible:outline-none focus-visible:shadow-(--shadow-focus)',
          '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-foreground',
          '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer',
          '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground'
        )}
      />
      <span className="w-9 text-right text-sm tabular-nums text-foreground">{value}%</span>
    </div>
  );

  return (
    <>
      {/* Claude subscriptions and API profiles (Anthropic-compatible endpoints) Claude Code signs in with */}
      <SettingsSection title={t('accounts.title')}>
        <SettingsRows>
          <ClaudeAccountsSection />
          <ProfileList />
        </SettingsRows>
      </SettingsSection>

      {/* Spending per project (all tasks' Claude Code run costs) */}
      <ProjectMetricsSection />

      {/* Automatic account switching */}
      {totalAccounts > 1 && (
        <SettingsSection title={t('accounts.autoSwitching.title')}>
          {settingsError && (
            <p role="alert" className="mb-3 text-sm text-destructive">{settingsError}</p>
          )}
          <SettingsRows>
            <SettingsRow
              label={t('accounts.autoSwitching.enableAutoSwitching')}
              description={t('accounts.autoSwitching.description')}
            >
              <Switch
                checked={autoSwitchSettings?.enabled ?? false}
                onCheckedChange={(enabled) => handleUpdateAutoSwitch({ enabled })}
                disabled={isLoadingAutoSwitch}
                aria-label={t('accounts.autoSwitching.enableAutoSwitching')}
              />
            </SettingsRow>

            {autoSwitchSettings?.enabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.proactiveMonitoring')}
                description={t('accounts.autoSwitching.proactiveDescription')}
              >
                <Switch
                  checked={autoSwitchSettings?.proactiveSwapEnabled ?? true}
                  onCheckedChange={(value) => handleUpdateAutoSwitch({ proactiveSwapEnabled: value })}
                  disabled={isLoadingAutoSwitch}
                  aria-label={t('accounts.autoSwitching.proactiveMonitoring')}
                />
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && autoSwitchSettings?.proactiveSwapEnabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.sessionThreshold')}
                htmlFor="session-threshold"
                description={
                  <span id="session-threshold-description">
                    {t('accounts.autoSwitching.sessionThresholdDescription')}
                  </span>
                }
              >
                {thresholdSlider(
                  'session-threshold',
                  autoSwitchSettings?.sessionThreshold ?? 95,
                  (value) => handleUpdateAutoSwitch({ sessionThreshold: value }),
                  'session-threshold-description'
                )}
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && autoSwitchSettings?.proactiveSwapEnabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.weeklyThreshold')}
                htmlFor="weekly-threshold"
                description={
                  <span id="weekly-threshold-description">
                    {t('accounts.autoSwitching.weeklyThresholdDescription')}
                  </span>
                }
              >
                {thresholdSlider(
                  'weekly-threshold',
                  autoSwitchSettings?.weeklyThreshold ?? 99,
                  (value) => handleUpdateAutoSwitch({ weeklyThreshold: value }),
                  'weekly-threshold-description'
                )}
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.reactiveRecovery')}
                description={t('accounts.autoSwitching.reactiveDescription')}
              >
                <Switch
                  checked={autoSwitchSettings?.autoSwitchOnRateLimit ?? false}
                  onCheckedChange={(value) => handleUpdateAutoSwitch({ autoSwitchOnRateLimit: value })}
                  disabled={isLoadingAutoSwitch}
                  aria-label={t('accounts.autoSwitching.reactiveRecovery')}
                />
              </SettingsRow>
            )}

            {autoSwitchSettings?.enabled && (
              <SettingsRow
                label={t('accounts.autoSwitching.autoSwitchOnAuthFailure')}
                description={t('accounts.autoSwitching.autoSwitchOnAuthFailureDescription')}
              >
                <Switch
                  checked={autoSwitchSettings?.autoSwitchOnAuthFailure ?? false}
                  onCheckedChange={(value) => handleUpdateAutoSwitch({ autoSwitchOnAuthFailure: value })}
                  disabled={isLoadingAutoSwitch}
                  aria-label={t('accounts.autoSwitching.autoSwitchOnAuthFailure')}
                />
              </SettingsRow>
            )}
          </SettingsRows>
        </SettingsSection>
      )}
    </>
  );
}
