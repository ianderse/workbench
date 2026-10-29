/**
 * What the usage popover shows when there are no usage numbers to draw: an API profile billed
 * per token, usage that couldn't be fetched, and an account that has to sign in again. Shared by
 * the popover and the usage simulator in Settings, which previews each of them.
 *
 * They follow the usage card: its header (no divider), 11px muted descriptions, and the soft
 * filled button the settings dialog uses.
 */

import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';

/** The card's header, as the usage breakdown has it */
function StateHeader() {
  const { t } = useTranslation(['common']);
  return (
    <div className="flex items-center justify-between gap-2 pb-2 text-popover-foreground">
      <span className="text-xs font-semibold">{t('common:usage.usageBreakdown')}</span>
    </div>
  );
}

/** A state's message: a short title and a line under it */
function StateMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="truncate text-xs font-medium text-foreground">{title}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
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
export function ApiProfileUsageCard({ profileName, provider, onManageAccounts }: {
  profileName: string;
  provider: string;
  onManageAccounts: (event: React.MouseEvent) => void;
}) {
  const { t } = useTranslation(['common']);
  return (
    <div className="space-y-2.5 p-3">
      <StateHeader />
      <StateMessage title={`${profileName} · ${provider}`} description={t('common:usage.apiKeyUnknown')} />
      <StateAction label={t('common:usage.manageAccounts')} onClick={onManageAccounts} />
    </div>
  );
}

/** The account's usage couldn't be fetched */
export function UsageUnavailableCard() {
  const { t } = useTranslation(['common']);
  return (
    <div className="space-y-2.5 p-3">
      <StateHeader />
      <StateMessage title={t('common:usage.dataUnavailable')} description={t('common:usage.dataUnavailableDescription')} />
    </div>
  );
}

/** The account has to sign in again (its usage may or may not be known) */
export function ReauthRequiredCard({ onReauth }: { onReauth: (event: React.MouseEvent) => void }) {
  const { t } = useTranslation(['common']);
  return (
    <div className="space-y-2.5 p-3">
      <StateHeader />
      <StateMessage title={t('common:usage.reauthRequired')} description={t('common:usage.reauthRequiredDescription')} />
      <StateAction label={t('common:usage.reauthButton')} onClick={onReauth} />
    </div>
  );
}
