/**
 * Add a Claude account (name it, then sign in with Claude in the browser) or rename one.
 * Each account is a Claude Code profile with its own config dir, so several subscriptions can
 * be used side by side and swapped when one hits a limit.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import type { ClaudeProfile } from '../../../shared/types';

type SignInStatus = 'idle' | 'authenticating' | 'waiting' | 'success' | 'error';

interface ClaudeAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rename this account instead of adding one */
  profile?: ClaudeProfile;
  /** Called after an account was added, signed in or renamed */
  onSaved?: () => void;
}

export function ClaudeAccountDialog({ open, onOpenChange, profile, onSaved }: ClaudeAccountDialogProps) {
  const { t } = useTranslation('settings');
  const isRename = !!profile;

  const [name, setName] = useState('');
  const [status, setStatus] = useState<SignInStatus>('idle');
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Profile created by the first sign-in attempt, reused when retrying
  const [createdProfileId, setCreatedProfileId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? '');
    setStatus('idle');
    setEmail(null);
    setError(null);
    setCreatedProfileId(null);
  }, [open, profile]);

  // Sign-in progress from the main process
  useEffect(() => {
    if (!open || status === 'idle' || status === 'success') return;
    const unsubscribe = window.electronAPI.onClaudeAuthLoginProgress((data) => {
      if (data.status === 'authenticating' || data.status === 'waiting') {
        setStatus(data.status);
      } else if (data.status === 'error') {
        setStatus('error');
        setError(data.message ?? null);
      }
    });
    return unsubscribe;
  }, [open, status]);

  const isSigningIn = status === 'authenticating' || status === 'waiting';

  const handleSignIn = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setStatus('authenticating');
    setError(null);
    try {
      let profileId = createdProfileId;
      if (!profileId) {
        const created = await window.electronAPI.saveClaudeProfile({
          id: '',
          name: trimmed,
          isDefault: false,
          isAuthenticated: false,
          configDir: '',
          createdAt: new Date()
        });
        if (!created.success || !created.data) {
          setStatus('error');
          setError(created.error ?? null);
          return;
        }
        profileId = created.data.id;
        setCreatedProfileId(profileId);
      }
      const result = await window.electronAPI.claudeAuthLoginSubprocess(profileId);
      if (result.success && result.data?.authenticated) {
        setStatus('success');
        setEmail(result.data.email ?? null);
        onSaved?.();
      } else {
        setStatus('error');
        setError(result.error ?? null);
      }
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : null);
    }
  };

  const handleRename = async () => {
    if (!profile || !name.trim()) return;
    setIsSaving(true);
    setStatus('idle');
    try {
      const result = await window.electronAPI.renameClaudeProfile(profile.id, name.trim());
      if (result.success) {
        onSaved?.();
        onOpenChange(false);
      } else {
        // Shown in the dialog's error line
        setStatus('error');
        setError(result.error ?? t('claudeAccounts.toast.renameFailed'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    // Keep the dialog open while the browser sign-in is running
    if (isSigningIn) return;
    // A profile created for a sign-in that never finished is removed again
    if (!next && createdProfileId && status !== 'success') {
      void window.electronAPI.deleteClaudeProfile(createdProfileId).then(() => onSaved?.());
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isRename ? t('claudeAccounts.dialog.renameTitle') : t('claudeAccounts.dialog.addTitle')}</DialogTitle>
          <DialogDescription>
            {isRename ? t('claudeAccounts.dialog.renameDescription') : t('claudeAccounts.dialog.addDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 mt-4 min-h-0 space-y-4 overflow-y-auto px-6">
          <div className="space-y-2">
            <Label htmlFor="claude-account-name">{t('claudeAccounts.dialog.name')}</Label>
            <Input
              id="claude-account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('claudeAccounts.dialog.namePlaceholder')}
              disabled={isSigningIn || status === 'success'}
              autoFocus
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !name.trim()) return;
                e.preventDefault();
                if (isRename) void handleRename();
                else if (status !== 'success' && !isSigningIn) void handleSignIn();
              }}
            />
          </div>

          {isSigningIn && (
            <div className="flex items-center gap-2 rounded-xl bg-segment-track px-4 py-3 text-sm">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              <span>
                {status === 'waiting' ? t('claudeAccounts.dialog.waiting') : t('claudeAccounts.dialog.opening')}
              </span>
            </div>
          )}

          {status === 'success' && (
            <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
              {email ? t('claudeAccounts.dialog.signedInAs', { email }) : t('claudeAccounts.dialog.signedIn')}
            </div>
          )}

          {status === 'error' && (
            <div className="text-sm text-destructive" role="alert">
              {error ? t('claudeAccounts.dialog.error', { error }) : t('claudeAccounts.dialog.errorGeneric')}
            </div>
          )}
        </div>

        <DialogFooter>
          {status === 'success' ? (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              {t('claudeAccounts.dialog.done')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => handleOpenChange(false)} disabled={isSigningIn || isSaving}>
                {t('claudeAccounts.dialog.cancel')}
              </Button>
              {isRename ? (
                <Button size="sm" onClick={handleRename} disabled={!name.trim() || isSaving}>
                  {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {t('claudeAccounts.dialog.save')}
                </Button>
              ) : (
                <Button size="sm" onClick={handleSignIn} disabled={!name.trim() || isSigningIn}>
                  {isSigningIn && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {status === 'error' ? t('claudeAccounts.dialog.tryAgain') : t('claudeAccounts.dialog.signIn')}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
