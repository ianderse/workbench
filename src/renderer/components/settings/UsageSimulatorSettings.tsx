import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../ui/input';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { UsageHero } from '../usage/UsageBreakdown';
import { createSkinPicker } from '../usage/clawd/skins';
import { IS_DEV_BUILD } from '../../lib/title-bar';
import { simulatedMoment, useUsageSimulatorStore } from '../../stores/usage-simulator-store';
import { useUsageStore } from '../../stores/usage-store';
import type { ClaudeUsageSnapshot } from '../../../shared/types/agent';

/** The preview's own skin memory, so trying values here never changes the popover's Clawd */
const previewSkin = createSkinPicker();

/** Stands in for the real usage before any has arrived */
const NO_USAGE: ClaudeUsageSnapshot = {
  sessionPercent: 0,
  weeklyPercent: 0,
  profileId: '',
  profileName: '',
  fetchedAt: new Date(0),
};

/**
 * Development builds only (like the DEVELOPMENT BUILD strip): a live preview of the top of the
 * usage popover, at its real size, with a pretend date and time and 5-hour usage - to see the
 * sky (day and night, the moon's phase, rain and winter snow) and Clawd's moods and seasonal
 * skins at any moment. Empty fields use the real values; the real popover is never affected.
 */
export function UsageSimulatorSettings() {
  const { t } = useTranslation('settings');
  const clock = useUsageSimulatorStore((state) => state.clock);
  const setClock = useUsageSimulatorStore((state) => state.setClock);
  const sessionPercent = useUsageSimulatorStore((state) => state.sessionPercent);
  const setSessionPercent = useUsageSimulatorStore((state) => state.setSessionPercent);
  const realUsage = useUsageStore((state) => state.usage);
  // The sidebar's badge feeds the store, but it is not mounted while the sidebar is collapsed:
  // keep the store fed from here while the preview is on screen
  useEffect(() => {
    if (!IS_DEV_BUILD) return;
    const { setUsage } = useUsageStore.getState();
    const unsubscribe = window.electronAPI.onUsageUpdated((snapshot) => setUsage(snapshot));
    if (!useUsageStore.getState().usage) {
      window.electronAPI.requestUsageUpdate()
        .then((result) => { if (result.success && result.data) setUsage(result.data); })
        .catch(() => {});
    }
    return unsubscribe;
  }, []);

  const pinned = useMemo(() => simulatedMoment(clock), [clock]);
  const usage = useMemo(() => {
    const base = realUsage ?? NO_USAGE;
    return sessionPercent == null ? base : { ...base, sessionPercent };
  }, [realUsage, sessionPercent]);

  if (!IS_DEV_BUILD) return null;

  return (
    <SettingsSection title={t('usageSimulator.title')}>
      {/* The popover's own width, surface and padding, so the preview matches it pixel for pixel */}
      <div className="w-[17rem] rounded-xl border border-border bg-popover text-xs text-popover-foreground shadow-[0_8px_24px_rgba(0,0,0,0.24)]">
        <div className="space-y-2.5 p-3">
          <UsageHero usage={usage} active pickSkin={previewSkin} pinned={pinned} />
        </div>
      </div>

      <SettingsRows className="mt-4">
        <SettingsRow
          label={t('usageSimulator.clockLabel')}
          description={t('usageSimulator.clockDescription')}
          htmlFor="usage-simulator-clock"
        >
          <Input
            id="usage-simulator-clock"
            type="datetime-local"
            className="w-56"
            value={clock ?? ''}
            onChange={(e) => setClock(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          label={t('usageSimulator.percentLabel')}
          description={t('usageSimulator.percentDescription')}
          htmlFor="usage-simulator-percent"
        >
          <Input
            id="usage-simulator-percent"
            type="number"
            min={0}
            max={100}
            step={1}
            className="w-24"
            placeholder={t('usageSimulator.percentPlaceholder')}
            value={sessionPercent ?? ''}
            onChange={(e) => setSessionPercent(e.target.value === '' ? null : Number(e.target.value))}
          />
        </SettingsRow>
      </SettingsRows>
    </SettingsSection>
  );
}
