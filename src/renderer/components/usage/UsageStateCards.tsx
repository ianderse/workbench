/**
 * What the usage popover shows when there are no usage numbers to draw: an API profile billed
 * per token, usage that couldn't be fetched, and an account that has to sign in again. Shared by
 * the popover and the usage simulator in Settings, which previews each of them.
 *
 * They follow the usage card: its header (no divider), the sky with Clawd asleep in it in place
 * of the numbers, an 11px muted line saying why, and the soft filled button the settings dialog
 * uses.
 */

import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { SleepingSky } from './UsageBreakdown';

/** What every state card takes for its sky */
interface SkyProps {
  /** Clawd only animates while this is on (the popover is open, the preview is on screen) */
  active: boolean;
  /** A pinned moment for the sky (the usage simulator's), or null for now */
  pinned?: Date | null;
}

/** The card's header, as the usage breakdown has it */
function StateHeader() {
  const { t } = useTranslation(['common']);
  return (
    <div className="flex items-center justify-between gap-2 pb-2 text-popover-foreground">
      <span className="text-xs font-semibold">{t('common:usage.usageBreakdown')}</span>
    </div>
  );
}

/** A state's message: one line saying why there is nothing to show */
function StateMessage({ description }: { description: string }) {
  return <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>;
}

/** The state's action, a full-width soft filled button */
function StateAction({ label, onClick }: { label: string; onClick: (event: React.MouseEvent) => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className="w-full rounded-lg border-transparent bg-fill-control hover:bg-fill-control-hover hover:text-foreground"
    >
      {label}
    </Button>
  );
}

/** An API profile (Anthropic-compatible endpoint): billed per token, so there's no limit to show */
export function ApiProfileUsageCard({ onManageAccounts, active, pinned }: SkyProps & {
  onManageAccounts: (event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation(['common']);
  return (
    <div className="space-y-2.5 p-3">
      <StateHeader />
      <SleepingSky active={active} pinned={pinned} />
      <StateMessage description={t('common:usage.apiKeyUnknown')} />
      <StateAction label={t('common:usage.manageAccounts')} onClick={onManageAccounts} />
    </div>
  );
}

/** The account's usage couldn't be fetched */
export function UsageUnavailableCard({ active, pinned }: SkyProps) {
  const { t } = useTranslation(['common']);
  return (
    <div className="space-y-2.5 p-3">
      <StateHeader />
      <SleepingSky active={active} pinned={pinned} />
      <StateMessage description={t('common:usage.dataUnavailableDescription')} />
    </div>
  );
}

/** The account has to sign in again (its usage may or may not be known) */
export function ReauthRequiredCard({ onReauth, active, pinned }: SkyProps & { onReauth: (event: React.MouseEvent) => void }) {
  const { t } = useTranslation(['common']);
  return (
    <div className="space-y-2.5 p-3">
      <StateHeader />
      <SleepingSky active={active} pinned={pinned} />
      <StateMessage description={t('common:usage.reauthRequiredDescription')} />
      <StateAction label={t('common:usage.reauthButton')} onClick={onReauth} />
    </div>
  );
}
