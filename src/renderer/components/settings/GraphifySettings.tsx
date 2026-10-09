import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { ExternalLink } from '../ui/external-link';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { useGraphifyVersion } from '../../hooks/useGraphifyVersion';

// Delay before re-checking the version after the install terminal opens
const VERSION_RECHECK_DELAY_MS = 5000;

/**
 * Graphify CLI (builds the projects' memory graphs): status, install/update, version and its
 * /graphify command in Claude Code (set up after an install, or with the Set up button)
 */
export function GraphifySettings() {
  const { t } = useTranslation(['navigation']);
  const { info, lastChecked, isChecking, error, refresh } = useGraphifyVersion();
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isSettingUpCommand, setIsSettingUpCommand] = useState(false);

  const status = isChecking && !info
    ? 'loading'
    : error !== null
      ? 'error'
      : !info?.installed
        ? 'not-found'
        : info.isOutdated
          ? 'outdated'
          : 'installed';

  const statusText = {
    loading: t('navigation:graphify.checking'),
    installed: t('navigation:graphify.upToDate'),
    outdated: t('navigation:graphify.updateAvailable'),
    'not-found': t('navigation:graphify.notInstalled'),
    error: t('navigation:graphify.error'),
  }[status];

  const handleInstall = async () => {
    setIsInstalling(true);
    setInstallError(null);
    try {
      const result = await window.electronAPI.installGraphify();
      if (result.success) {
        setTimeout(() => void refresh(), VERSION_RECHECK_DELAY_MS);
      } else {
        setInstallError(result.error || t('navigation:graphify.installFailed'));
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : t('navigation:graphify.installFailed'));
    } finally {
      setIsInstalling(false);
    }
  };

  const handleSetUpCommand = async () => {
    setIsSettingUpCommand(true);
    setInstallError(null);
    try {
      const result = await window.electronAPI.installGraphifyClaudeCommand();
      if (!result.success) setInstallError(result.error || t('navigation:graphify.claudeCommandFailed'));
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : t('navigation:graphify.claudeCommandFailed'));
    } finally {
      setIsSettingUpCommand(false);
      void refresh();
    }
  };

  const claudeCommand = info?.claudeCommand ?? null;

  return (
    <SettingsSection title={t('navigation:graphify.title')} description={t('navigation:graphify.description')}>
      <SettingsRows>
        {/* Status + install/update/refresh */}
        <SettingsRow label={t('navigation:graphify.status')} description={statusText}>
          {(status === 'not-found' || status === 'outdated') && (
            <Button size="sm" className="gap-1.5" onClick={handleInstall} disabled={isInstalling}>
              {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {status === 'outdated' ? t('navigation:graphify.update') : t('navigation:graphify.install')}
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()} disabled={isChecking}>
            <RefreshCw className={cn('h-3.5 w-3.5', isChecking && 'animate-spin')} />
            {t('navigation:graphify.refresh')}
          </Button>
        </SettingsRow>

        {/* Installed version */}
        {info?.installed && (
          <SettingsRow
            label={t('navigation:graphify.version')}
            description={[
              info.latest ? `${t('navigation:graphify.latest')} ${info.latest}` : null,
              lastChecked ? `${t('navigation:graphify.lastChecked')} ${lastChecked.toLocaleTimeString()}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            <span className="font-mono text-sm">{info.installed}</span>
          </SettingsRow>
        )}

        {/* The /graphify command in Claude Code (one skill per Claude Code config directory) */}
        {info?.installed && claudeCommand && (
          <SettingsRow
            label={t('navigation:graphify.claudeCommand')}
            description={
              claudeCommand.missing === 0
                ? t('navigation:graphify.claudeCommandReady')
                : t('navigation:graphify.claudeCommandMissing', { count: claudeCommand.missing })
            }
          >
            {claudeCommand.missing > 0 && (
              <Button size="sm" className="gap-1.5" onClick={handleSetUpCommand} disabled={isSettingUpCommand}>
                {isSettingUpCommand ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
                {t('navigation:graphify.setUp')}
              </Button>
            )}
          </SettingsRow>
        )}

        {/* Changelog */}
        <SettingsRow label={t('navigation:graphify.changelog')}>
          <ExternalLink
            href="https://github.com/Graphify-Labs/graphify/blob/v8/CHANGELOG.md"
            aria-label={t('navigation:graphify.viewChangelogAriaLabel')}
          >
            {t('navigation:graphify.viewChangelog')}
          </ExternalLink>
        </SettingsRow>
      </SettingsRows>

      {installError && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-segment-track px-4 py-3 text-sm text-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--error)]" strokeWidth={1.75} />
          <span>{installError}</span>
        </div>
      )}
    </SettingsSection>
  );
}
