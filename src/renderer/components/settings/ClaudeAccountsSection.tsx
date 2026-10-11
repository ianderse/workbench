/**
 * Claude accounts (Accounts page): the Claude Code setups found in its own configuration (see
 * claude-code-detection). One account is in use; with automatic switching on, tasks move to the
 * next account when it hits a limit. Each row shows the account's email and usage (or its
 * provider); its menu switches to it, signs it in again and shows its details. Adding an account
 * runs Claude Code's own sign-in in a terminal.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Info, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { cn } from '../../lib/utils';
import { SettingsRow } from './SettingsRow';
import { ClaudeLoginDialog } from './ClaudeLoginDialog';
import { DetectedAccountDialog } from './DetectedAccountDialog';
import { useClaudeAccounts } from './hooks/useClaudeAccounts';
import type { ClaudeProfile } from '../../../shared/types';

export function ClaudeAccountsSection() {
  const { t } = useTranslation('settings');
  const { profiles: allProfiles, activeProfileId, usage, reload } = useClaudeAccounts();
  // Only Claude Code's own setups are accounts
  const profiles = allProfiles.filter((profile) => profile.detected);

  // Claude Code's sign-in in a terminal: a new account, or one to sign in again
  const [login, setLogin] = useState<{ open: boolean; profile?: ClaudeProfile }>({ open: false });
  // Details (and name) of an account
  const [details, setDetails] = useState<{ open: boolean; profile?: ClaudeProfile }>({ open: false });
  const [busyId, setBusyId] = useState<string | null>(null);
  // The last failed action on an account, shown in its row instead of the description
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const handleUse = async (profile: ClaudeProfile) => {
    setBusyId(profile.id);
    setRowError(null);
    try {
      const result = await window.electronAPI.setActiveClaudeProfile(profile.id);
      if (!result.success) {
        const title = t('claudeAccounts.toast.switchFailed');
        setRowError({ id: profile.id, message: result.error ? `${title}: ${result.error}` : title });
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const describe = (profile: ClaudeProfile): string => {
    // A setup on a cloud provider, an API key or a gateway: what it reaches Claude through
    const detected = profile.detected;
    if (detected && detected.provider !== 'subscription') {
      const where = ['AWS_REGION', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_BASE_URL']
        .map((key) => detected.values.find((value) => value.key === key)?.value)
        .find(Boolean);
      return [t(`claudeAccounts.providers.${detected.provider}`), where].filter(Boolean).join(' · ');
    }
    const summary = usage.get(profile.id);
    const email = summary?.profileEmail || profile.email;
    const parts: string[] = [];
    if (profile.isAuthenticated === false && !summary?.isAuthenticated) {
      parts.push(t('claudeAccounts.notSignedIn'));
    } else if (email) {
      parts.push(email);
    }
    if (summary?.needsReauthentication) parts.push(t('claudeAccounts.needsSignIn'));
    if (summary?.isRateLimited) parts.push(t('claudeAccounts.rateLimited'));
    if (summary && summary.isAuthenticated && !summary.fetchError) {
      parts.push(t('claudeAccounts.usage', {
        session: Math.round(summary.sessionPercent),
        weekly: Math.round(summary.weeklyPercent)
      }));
    }
    return parts.join(' · ');
  };

  return (
    <>
      {profiles.map((profile) => {
        const isActive = profile.id === activeProfileId;
        const isBusy = busyId === profile.id;
        return (
          <SettingsRow
            key={profile.id}
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{profile.name}</span>
                {isActive && <span className="shrink-0 text-(--nav-label-color)">{t('claudeAccounts.inUse')}</span>}
              </span>
            }
            description={
              rowError?.id === profile.id ? (
                <span role="alert" className="text-destructive">{rowError.message}</span>
              ) : (
                describe(profile) || undefined
              )
            }
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn('h-8 w-8 text-muted-foreground', isBusy && 'pointer-events-none opacity-50')}
                  aria-label={t('claudeAccounts.menu', { name: profile.name })}
                >
                  <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem className="cursor-pointer" disabled={isActive} onSelect={() => void handleUse(profile)}>
                  <Check className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                  {isActive ? t('claudeAccounts.inUse') : t('claudeAccounts.use')}
                </DropdownMenuItem>
                {/* A subscription sign-in signs in again with Claude Code's own login */}
                {profile.detected?.provider === 'subscription' && (
                  <DropdownMenuItem className="cursor-pointer" onSelect={() => setLogin({ open: true, profile })}>
                    <RefreshCw className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                    {t('claudeAccounts.signInAgain')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="cursor-pointer" onSelect={() => setDetails({ open: true, profile })}>
                  <Info className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                  {t('claudeAccounts.details')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={t('claudeAccounts.add')}
        description={profiles.length > 1 ? t('claudeAccounts.addDescriptionMore') : t('claudeAccounts.addDescription')}
      >
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLogin({ open: true })}>
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t('claudeAccounts.addButton')}
        </Button>
      </SettingsRow>

      <ClaudeLoginDialog
        open={login.open}
        profile={login.profile}
        onOpenChange={(open) => setLogin((current) => ({ ...current, open }))}
        onDetected={() => void reload()}
      />

      <DetectedAccountDialog
        open={details.open}
        profile={details.profile}
        onOpenChange={(open) => setDetails((current) => ({ ...current, open }))}
        onSaved={() => void reload()}
      />
    </>
  );
}
