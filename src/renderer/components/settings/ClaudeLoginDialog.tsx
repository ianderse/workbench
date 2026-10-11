/**
 * Claude Code's own sign-in (`claude auth login`) in a terminal: for a new account, or to sign an
 * account in again. Claude Code handles the sign-in and writes the credentials itself; when it
 * exits, Claude Code's setups are detected again so the account shows up in the list.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { getTerminalTheme } from '../../lib/terminal-theme';
import { useTerminalFontSettingsStore } from '../../stores/terminal-font-settings-store';
import type { ClaudeProfile } from '../../../shared/types';

interface ClaudeLoginDialogProps {
  open: boolean;
  /** Account to sign in again; a new account when omitted */
  profile?: ClaudeProfile;
  onOpenChange: (open: boolean) => void;
  /** The accounts were detected again */
  onDetected: () => void;
}

type LoginState =
  | { phase: 'running' }
  | { phase: 'checking' }
  | { phase: 'done'; email?: string }
  | { phase: 'not-signed-in' }
  | { phase: 'error'; message: string };

export function ClaudeLoginDialog({ open, profile, onOpenChange, onDetected }: ClaudeLoginDialogProps) {
  const { t } = useTranslation('settings');
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoginState>({ phase: 'running' });
  const fontSettings = useTerminalFontSettingsStore();

  useEffect(() => {
    if (!open || !containerRef.current) return;
    setState({ phase: 'running' });
    const id = `claude-login-${Date.now()}`;
    let exited = false;

    const xterm = new XTerm({
      fontSize: fontSettings.fontSize,
      fontFamily: fontSettings.fontFamily.join(', '),
      lineHeight: fontSettings.lineHeight,
      theme: getTerminalTheme(),
      cursorBlink: true,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    // The sign-in prints its URL: open it in the browser on click
    xterm.loadAddon(new WebLinksAddon((_event, uri) => void window.electronAPI.openExternal(uri)));
    xterm.open(containerRef.current);
    fit.fit();

    // Accounts before the sign-in, to tell which one it added
    const before = window.electronAPI.getClaudeProfiles().then((result) =>
      new Set((result.success ? result.data?.profiles ?? [] : []).filter((p) => p.detected).map((p) => p.id))
    );

    const offOutput = window.electronAPI.onTerminalOutput((terminalId, data) => {
      if (terminalId === id) xterm.write(data);
    });
    const offExit = window.electronAPI.onTerminalExit((terminalId) => {
      if (terminalId !== id) return;
      exited = true;
      setState({ phase: 'checking' });
      void (async () => {
        const known = await before;
        const result = await window.electronAPI.redetectClaudeAccounts();
        onDetected();
        if (!result.success || !result.data) {
          setState({ phase: 'error', message: result.error ?? t('claudeAccounts.login.notSignedIn') });
          return;
        }
        const accounts = result.data.profiles.filter((p) => p.detected?.provider === 'subscription' && p.isAuthenticated);
        const signedIn = profile
          ? accounts.find((p) => p.id === profile.id)
          : accounts.find((p) => !known.has(p.id));
        setState(signedIn ? { phase: 'done', email: signedIn.email } : { phase: 'not-signed-in' });
      })();
    });
    const inputListener = xterm.onData((data) => window.electronAPI.sendTerminalInput(id, data));

    const observer = new ResizeObserver(() => {
      fit.fit();
      void window.electronAPI.resizeTerminal(id, xterm.cols, xterm.rows);
    });
    observer.observe(containerRef.current);

    void window.electronAPI
      .createTerminal({ id, cols: xterm.cols, rows: xterm.rows, claudeLogin: { profileId: profile?.id } })
      .then((result) => {
        if (!result.success) setState({ phase: 'error', message: result.error ?? t('claudeAccounts.login.failedToStart') });
        else xterm.focus();
      });

    return () => {
      observer.disconnect();
      inputListener.dispose();
      offOutput();
      offExit();
      // Closing the dialog stops a sign-in that is still running
      if (!exited) void window.electronAPI.destroyTerminal(id);
      xterm.dispose();
    };
    // The terminal is created once per opening
  }, [open]);

  const status =
    state.phase === 'checking' ? (
      <span className="flex items-center gap-2 text-(--nav-label-color)">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('claudeAccounts.login.checking')}
      </span>
    ) : state.phase === 'done' ? (
      <span className="text-foreground">
        {state.email ? t('claudeAccounts.login.signedInAs', { email: state.email }) : t('claudeAccounts.login.signedIn')}
      </span>
    ) : state.phase === 'not-signed-in' ? (
      <span className="text-(--nav-label-color)">{t('claudeAccounts.login.notSignedIn')}</span>
    ) : state.phase === 'error' ? (
      <span role="alert" className="text-destructive">{state.message}</span>
    ) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{profile ? t('claudeAccounts.login.signInAgainTitle', { name: profile.name }) : t('claudeAccounts.login.title')}</DialogTitle>
          <DialogDescription>{t('claudeAccounts.login.description')}</DialogDescription>
        </DialogHeader>

        <div
          className="mt-2 h-80 overflow-hidden rounded-lg p-2"
          style={{ backgroundColor: getTerminalTheme().background }}
        >
          <div ref={containerRef} className="h-full w-full" />
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="min-w-0 text-sm">{status}</div>
          <Button size="sm" variant={state.phase === 'running' ? 'ghost' : 'default'} onClick={() => onOpenChange(false)}>
            {state.phase === 'running' ? t('claudeAccounts.dialog.cancel') : t('claudeAccounts.login.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
