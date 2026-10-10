/**
 * Claude accounts (Accounts page): the Claude subscriptions Claude Code signs in
 * with. One account is in use; with automatic switching on, tasks move to the next account when
 * it hits a limit. Each row shows the account's email and usage; its menu switches to it, signs
 * in again, renames or removes it.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button, buttonVariants } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog';
import { cn } from '../../lib/utils';
import { useToast } from '../../hooks/use-toast';
import { SettingsRow } from './SettingsRow';
import { ClaudeAccountDialog } from './ClaudeAccountDialog';
import { useClaudeAccounts } from './hooks/useClaudeAccounts';
import type { ClaudeProfile } from '../../../shared/types';

export function ClaudeAccountsSection() {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const { profiles, activeProfileId, usage, reload } = useClaudeAccounts();

  const [dialog, setDialog] = useState<{ open: boolean; profile?: ClaudeProfile }>({ open: false });
  const [removeTarget, setRemoveTarget] = useState<ClaudeProfile | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleUse = async (profile: ClaudeProfile) => {
    setBusyId(profile.id);
    try {
      const result = await window.electronAPI.setActiveClaudeProfile(profile.id);
      if (!result.success) {
        toast({ variant: 'destructive', title: t('claudeAccounts.toast.switchFailed'), description: result.error ?? '' });
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const handleSignInAgain = async (profile: ClaudeProfile) => {
    setBusyId(profile.id);
    toast({ title: t('claudeAccounts.toast.signInStarted') });
    try {
      const result = await window.electronAPI.claudeAuthLoginSubprocess(profile.id);
      if (result.success && result.data?.authenticated) {
        toast({ title: t('claudeAccounts.toast.signedIn'), description: result.data.email ?? profile.name });
      } else {
        toast({ variant: 'destructive', title: t('claudeAccounts.toast.signInFailed'), description: result.error ?? '' });
      }
      await reload();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('claudeAccounts.toast.signInFailed'),
        description: err instanceof Error ? err.message : ''
      });
    } finally {
      setBusyId(null);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setBusyId(target.id);
    try {
      const result = await window.electronAPI.deleteClaudeProfile(target.id);
      if (result.success) {
        toast({ title: t('claudeAccounts.toast.removed'), description: target.name });
      } else {
        toast({ variant: 'destructive', title: t('claudeAccounts.toast.removeFailed'), description: result.error ?? '' });
      }
      await reload();
    } finally {
      setBusyId(null);
      setRemoveTarget(null);
    }
  };

  const describe = (profile: ClaudeProfile): string => {
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
            description={describe(profile) || undefined}
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
                <DropdownMenuItem className="cursor-pointer" onSelect={() => void handleSignInAgain(profile)}>
                  <RefreshCw className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                  {t('claudeAccounts.signInAgain')}
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer" onSelect={() => setDialog({ open: true, profile })}>
                  <Pencil className="h-4 w-4 text-(--nav-label-color)" strokeWidth={1.75} />
                  {t('claudeAccounts.rename')}
                </DropdownMenuItem>
                {!profile.isDefault && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="cursor-pointer text-destructive focus:bg-destructive/10 focus:text-destructive"
                      onSelect={() => setRemoveTarget(profile)}
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      {t('claudeAccounts.remove')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={t('claudeAccounts.add')}
        description={profiles.length > 1 ? t('claudeAccounts.addDescriptionMore') : t('claudeAccounts.addDescription')}
      >
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ open: true })}>
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t('claudeAccounts.addButton')}
        </Button>
      </SettingsRow>

      <ClaudeAccountDialog
        open={dialog.open}
        profile={dialog.profile}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        onSaved={() => void reload()}
      />

      <AlertDialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('claudeAccounts.removeDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('claudeAccounts.removeDialog.description', { name: removeTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>{t('claudeAccounts.dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemove}
              disabled={busyId !== null}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {t('claudeAccounts.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
