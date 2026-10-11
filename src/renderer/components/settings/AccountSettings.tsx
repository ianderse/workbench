/**
 * AccountSettings - how Claude Code signs in
 *
 * claude.ai settings layout: Claude accounts (subscriptions, with usage), API profiles
 * (Anthropic-compatible endpoints), spending per project (Metrics), automatic account switching
 * and the switching order.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '../ui/switch';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { AccountPriorityList, type UnifiedAccount } from './AccountPriorityList';
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

/** Priority order entries are Claude profile ids with this prefix (shared with the profile scorer) */
const PRIORITY_ID_PREFIX = 'oauth-';

export function AccountSettings({ isOpen }: AccountSettingsProps) {
  const { t } = useTranslation('settings');
  const { profiles, activeProfileId, usage, reload } = useClaudeAccounts(isOpen);

  const [autoSwitchSettings, setAutoSwitchSettings] = useState<ClaudeAutoSwitchSettings | null>(null);
  const [isLoadingAutoSwitch, setIsLoadingAutoSwitch] = useState(false);
  const [priorityOrder, setPriorityOrder] = useState<string[]>([]);
  const [isSavingPriority, setIsSavingPriority] = useState(false);

  // A failed settings change, shown at the top of the section it came from
  const [settingsError, setSettingsError] = useState<{ section: 'switching' | 'priority'; message: string } | null>(null);
  const showUpdateFailed = useCallback((section: 'switching' | 'priority', description?: string) => {
    setSettingsError({
      section,
      message: `${t('accounts.toast.settingsUpdateFailed')}: ${description || t('accounts.toast.tryAgain')}`,
    });
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
    window.electronAPI.getAccountPriorityOrder?.()
      .then((result) => {
        if (result.success && result.data) setPriorityOrder(result.data);
      })
      .catch(() => {
        // Non-fatal: accounts keep their natural order
      });
  }, [isOpen, loadAutoSwitchSettings]);

  const handleUpdateAutoSwitch = async (updates: Partial<ClaudeAutoSwitchSettings>) => {
    setIsLoadingAutoSwitch(true);
    setSettingsError(null);
    try {
      const result = await window.electronAPI.updateAutoSwitchSettings(updates);
      if (result.success) {
        await loadAutoSwitchSettings();
      } else {
        showUpdateFailed('switching', result.error);
      }
    } catch {
      showUpdateFailed('switching');
    } finally {
      setIsLoadingAutoSwitch(false);
    }
  };

  // Claude accounts in switching order (accounts missing from the saved order come last)
  const orderedProfiles = [...profiles].sort((a, b) => {
    const aPos = priorityOrder.indexOf(`${PRIORITY_ID_PREFIX}${a.id}`);
    const bPos = priorityOrder.indexOf(`${PRIORITY_ID_PREFIX}${b.id}`);
    return (aPos === -1 ? Infinity : aPos) - (bPos === -1 ? Infinity : bPos);
  });

  const priorityAccounts: UnifiedAccount[] = orderedProfiles.map((profile) => {
    const summary = usage.get(profile.id);
    const email = summary?.profileEmail || profile.email;
    const isAuthenticated = summary?.isAuthenticated ?? profile.isAuthenticated !== false;
    return {
      id: profile.id,
      name: profile.name,
      type: 'oauth',
      displayName: profile.name,
      identifier: email || t('accounts.priority.noEmail'),
      profileEmail: email,
      isActive: profile.id === activeProfileId,
      isNext: false,
      isAvailable: isAuthenticated,
      isAuthenticated,
      hasUnlimitedUsage: false,
      sessionPercent: summary?.sessionPercent,
      weeklyPercent: summary?.weeklyPercent,
      isRateLimited: summary?.isRateLimited,
      rateLimitType: summary?.rateLimitType,
      needsReauthentication: summary?.needsReauthentication,
    };
  });

  const savePriorityOrder = async (profileIds: string[]) => {
    const order = profileIds.map((id) => `${PRIORITY_ID_PREFIX}${id}`);
    setIsSavingPriority(true);
    setSettingsError(null);
    try {
      const result = await window.electronAPI.setAccountPriorityOrder(order);
      if (result.success) {
        setPriorityOrder(order);
      } else {
        showUpdateFailed('priority', result.error);
      }
    } catch {
      showUpdateFailed('priority');
    } finally {
      setIsSavingPriority(false);
    }
  };

  // Use an account now and put it first in the order
  const handleSetActive = async (profileId: string) => {
    setIsSavingPriority(true);
    try {
      const result = await window.electronAPI.setActiveClaudeProfile(profileId);
      if (!result.success) {
        showUpdateFailed('priority', result.error);
        return;
      }
    } finally {
      setIsSavingPriority(false);
    }
    await savePriorityOrder([profileId, ...orderedProfiles.map((p) => p.id).filter((id) => id !== profileId)]);
    await reload();
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
          {settingsError?.section === 'switching' && (
            <p role="alert" className="mb-3 text-sm text-destructive">{settingsError.message}</p>
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

      {/* Switching order */}
      {totalAccounts > 1 && autoSwitchSettings?.enabled && (
        <SettingsSection title={t('accounts.priority.title')}>
          <p className="-mt-2 mb-1 text-sm text-(--nav-label-color)">{t('accounts.priority.description')}</p>
          {settingsError?.section === 'priority' && (
            <p role="alert" className="mb-3 text-sm text-destructive">{settingsError.message}</p>
          )}
          <AccountPriorityList
            accounts={priorityAccounts}
            onReorder={(ids) => void savePriorityOrder(ids)}
            onSetActive={(id) => void handleSetActive(id)}
            isLoading={isSavingPriority}
          />
        </SettingsSection>
      )}
    </>
  );
}
