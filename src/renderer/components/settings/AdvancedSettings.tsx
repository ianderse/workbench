import { useState, useEffect, useCallback, useRef } from 'react';
import semver from 'semver';
import { useTranslation } from 'react-i18next';
import {
  RefreshCw,
  Download,
  ArrowDownToLine,
  Loader2,
  X
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Button } from '../ui/button';
import { ExternalLink } from '../ui/external-link';
import { Switch } from '../ui/switch';
import { Progress } from '../ui/progress';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsRows } from './SettingsRow';
import { readRefreshCache, writeRefreshCache } from '../../lib/refresh-cache';
import type {
  AppSettings,
  AppUpdateCheckResult,
  AppUpdateProgress,
  AppUpdateInfo,
  IPCResult,
  NotificationSettings
} from '../../../shared/types';

/**
 * Release notes renderer that handles both HTML and markdown input.
 * GitHub release notes come as HTML, so we detect and handle both formats.
 * Uses ReactMarkdown with rehype-sanitize to prevent XSS attacks.
 */
/** Safe link component that opens external URLs in the default browser */
const safeMarkdownComponents: Components = {
  a: ({ href, children, ...props }) => {
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');
    return (
      <a
        href={href}
        {...props}
        {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
        className="text-primary hover:underline"
      >
        {children}
      </a>
    );
  }
};

function ReleaseNotesRenderer({ content }: { content: string }) {
  return (
    <div className="text-sm text-muted-foreground leading-relaxed prose prose-sm dark:prose-invert max-w-none [&_ul]:ml-4 [&_ol]:ml-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={safeMarkdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Whether `candidate` is a newer version than `current` (false when either isn't semver) */
function isNewerVersion(candidate: string, current: string): boolean {
  const a = semver.valid(candidate);
  const b = semver.valid(current);
  return !!a && !!b && semver.gt(a, b);
}

/** A release's page on GitHub (its changelog); releases are tagged v<version> */
function releaseUrl(version: string): string {
  return `https://github.com/proactive-agent/workbench/releases/tag/v${version}`;
}

interface AdvancedSettingsProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  section: 'updates' | 'notifications';
  version: string;
}

/**
 * Advanced settings for updates and notifications
 */
export function AdvancedSettings({ settings, onSettingsChange, section, version }: AdvancedSettingsProps) {
  const { t } = useTranslation('settings');

  // Electron app update state
  const [checkResult, setCheckResult] = useState<AppUpdateCheckResult | null>(null);
  const [isCheckingAppUpdate, setIsCheckingAppUpdate] = useState(false);
  // The update downloaded in the main process (ready to install), whatever version it is
  const [downloadedUpdate, setDownloadedUpdate] = useState<AppUpdateInfo | null>(null);
  // The version being downloaded (the Download button of that version spins)
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(null);
  const [appDownloadProgress, setAppDownloadProgress] = useState<AppUpdateProgress | null>(null);
  // The "go back to stable" offer was dismissed
  const [downgradeDismissed, setDowngradeDismissed] = useState(false);
  // Read-only volume warning (shown when trying to install from DMG)
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);
  // General update error state
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);

  // Last update check result, per app version and Beta updates setting (a newer install starts fresh)
  const cacheKeyFor = (beta: boolean | undefined) => `app-update:${version}:${beta ? 'beta' : 'stable'}`;
  const appUpdateCacheKeyRef = useRef(cacheKeyFor(settings.betaUpdates));
  appUpdateCacheKeyRef.current = cacheKeyFor(settings.betaUpdates);
  const rememberAppUpdateCheck = useCallback((result: AppUpdateCheckResult) => {
    setCheckResult(result);
    if (result.status !== 'error') writeRefreshCache(appUpdateCacheKeyRef.current, result);
  }, []);

  // The newer version on offer. A downloaded update still shows (with Install) when there is no
  // check result to go by, as long as it is newer than the running version.
  const downloadedIsNewer = !!downloadedUpdate && isNewerVersion(downloadedUpdate.version, version);
  const appUpdateInfo: AppUpdateInfo | null =
    checkResult?.update ??
    (downloadedIsNewer && (!checkResult || checkResult.status === 'error') ? downloadedUpdate : null);
  const appUpdateStatus = checkResult?.status ?? null;
  const stableDowngradeInfo = downgradeDismissed ? null : checkResult?.downgrade ?? null;
  // Install only for the version that was actually downloaded, never for another one on offer
  const isAppUpdateDownloaded = !!appUpdateInfo && downloadedUpdate?.version === appUpdateInfo.version;
  const isDowngradeDownloaded = !!stableDowngradeInfo && downloadedUpdate?.version === stableDowngradeInfo.version;

  // On open: the downloaded update, and the main process's last check (e.g. the one at launch),
  // otherwise the last check this page remembers; only check when there is neither
  useEffect(() => {
    if (section !== 'updates') {
      return;
    }

    let isCancelled = false;

    (async () => {
      try {
        const result = await window.electronAPI.getDownloadedAppUpdate();
        if (isCancelled) return;
        if (result.success) setDownloadedUpdate(result.data ?? null);
      } catch (err) {
        console.error('Failed to check for downloaded update:', err);
        if (isCancelled) return;
      }

      try {
        const result = await window.electronAPI.getLastAppUpdateCheck();
        if (isCancelled) return;
        if (result.success && result.data) {
          rememberAppUpdateCheck(result.data);
          return;
        }
      } catch (err) {
        console.error('Failed to get the last update check:', err);
        if (isCancelled) return;
      }

      const cached = readRefreshCache<AppUpdateCheckResult>(appUpdateCacheKeyRef.current);
      if (cached) {
        setCheckResult(cached);
        return;
      }
      setIsCheckingAppUpdate(true);
      try {
        const result = await window.electronAPI.checkAppUpdate();
        if (isCancelled) return;
        rememberAppUpdateCheck(result.success && result.data ? result.data : { status: 'error', error: result.error });
      } catch (err) {
        console.error('Failed to check for app updates:', err);
        if (!isCancelled) setCheckResult({ status: 'error' });
      } finally {
        if (!isCancelled) {
          setIsCheckingAppUpdate(false);
        }
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, [section, rememberAppUpdateCheck]);

  // Listen for app update events
  useEffect(() => {
    // Any check the main process ran (launch, periodic, Beta updates switched, another window)
    const cleanupChecked = window.electronAPI.onAppUpdateChecked((result) => {
      rememberAppUpdateCheck(result);
      setIsCheckingAppUpdate(false);
    });

    const cleanupDownloaded = window.electronAPI.onAppUpdateDownloaded((info) => {
      setDownloadedUpdate(info);
      setDownloadingVersion(null);
      setAppDownloadProgress(null);
      setShowReadOnlyWarning(false);
      setAppUpdateError(null);
    });

    const cleanupProgress = window.electronAPI.onAppUpdateProgress((progress) => {
      setAppDownloadProgress(progress);
    });

    // Listen for read-only volume warning (when trying to install from DMG)
    const cleanupReadOnlyVolume = window.electronAPI.onAppUpdateReadOnlyVolume(() => {
      setShowReadOnlyWarning(true);
    });

    // Listen for update errors (e.g., download failures)
    const cleanupError = window.electronAPI.onAppUpdateError((error) => {
      setAppUpdateError(error.message);
      setDownloadingVersion(null);
      setAppDownloadProgress(null);
    });

    return () => {
      cleanupChecked();
      cleanupDownloaded();
      cleanupProgress();
      cleanupReadOnlyVolume();
      cleanupError();
    };
  }, [rememberAppUpdateCheck]);

  const checkForAppUpdates = async () => {
    setIsCheckingAppUpdate(true);
    try {
      const result = await window.electronAPI.checkAppUpdate();
      rememberAppUpdateCheck(result.success && result.data ? result.data : { status: 'error', error: result.error });
    } catch (err) {
      console.error('Failed to check for app updates:', err);
      setCheckResult({ status: 'error' });
    } finally {
      setIsCheckingAppUpdate(false);
    }
  };

  // Download a version; the Install button appears once the main process has it downloaded
  const startDownload = async (target: AppUpdateInfo, download: () => Promise<IPCResult>) => {
    setDownloadingVersion(target.version);
    setAppDownloadProgress(null);
    setAppUpdateError(null);
    try {
      const result = await download();
      if (!result.success) {
        setAppUpdateError(result.error || t('updates.downloadError'));
        setDownloadingVersion(null);
        return;
      }
      // Usually the downloaded event has arrived by now; on macOS it can come a moment later
      const downloaded = await window.electronAPI.getDownloadedAppUpdate();
      if (downloaded.success && downloaded.data) {
        setDownloadedUpdate(downloaded.data);
        setDownloadingVersion(null);
      }
    } catch (err) {
      console.error('Failed to download app update:', err);
      setAppUpdateError(t('updates.downloadError'));
      setDownloadingVersion(null);
    }
  };

  const handleDownloadAppUpdate = () => {
    if (appUpdateInfo) void startDownload(appUpdateInfo, window.electronAPI.downloadAppUpdate);
  };

  const handleDownloadStableVersion = () => {
    if (stableDowngradeInfo) void startDownload(stableDowngradeInfo, window.electronAPI.downloadStableUpdate);
  };

  const handleInstallAppUpdate = () => {
    window.electronAPI.installAppUpdate();
  };

  const dismissStableDowngrade = () => {
    setDowngradeDismissed(true);
  };

  if (section === 'updates') {
    const renderDownloadProgress = () =>
      downloadingVersion && appDownloadProgress ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('updates.downloading')}</span>
            <span className="text-foreground">{Math.round(appDownloadProgress.percent)}%</span>
          </div>
          <Progress value={appDownloadProgress.percent} className="h-1.5" />
          <p className="text-right text-xs text-muted-foreground">
            {(appDownloadProgress.transferred / 1024 / 1024).toFixed(2)} MB / {(appDownloadProgress.total / 1024 / 1024).toFixed(2)} MB
          </p>
        </div>
      ) : null;

    return (
      <SettingsSection
        title={t('updates.title')}
        description={t('updates.description')}
      >
        <SettingsRows>
          {/* Current Version Display */}
          <SettingsRow
            label={t('updates.version')}
            description={
              <span className="flex items-center gap-1.5">
                <span className="font-mono">{version || t('updates.loading')}</span>
                {appUpdateInfo ? (
                  <span className="flex items-center gap-1.5">
                    · {t('updates.newVersionAvailable')}
                    {/* The release's page on GitHub, where its changelog is */}
                    <ExternalLink
                      href={releaseUrl(appUpdateInfo.version)}
                      className="font-mono"
                      aria-label={t('updates.viewReleaseAriaLabel', { version: appUpdateInfo.version })}
                    >
                      {appUpdateInfo.version}
                    </ExternalLink>
                  </span>
                ) : (
                  !isCheckingAppUpdate &&
                  appUpdateStatus && (
                    <span>
                      ·{' '}
                      {appUpdateStatus === 'up-to-date'
                        ? t('updates.latestVersion')
                        : appUpdateStatus === 'unpublished'
                          ? t('updates.unpublishedVersion')
                          : t('updates.checkFailed')}
                    </span>
                  )
                )}
              </span>
            }
            footer={
              (renderDownloadProgress() || appUpdateError || showReadOnlyWarning) ? (
                <div className="space-y-3">
                  {renderDownloadProgress()}

                  {/* Update Error */}
                  {appUpdateError && (
                    <p className="text-sm text-destructive">
                      {appUpdateError}
                    </p>
                  )}

                  {/* Read-Only Volume Warning */}
                  {showReadOnlyWarning && (
                    <div className="rounded-xl bg-segment-track px-4 py-3 text-sm">
                      <p className="text-foreground">{t('updates.readOnlyVolumeTitle')}</p>
                      <p className="mt-0.5 text-muted-foreground">{t('updates.readOnlyVolumeDescription')}</p>
                    </div>
                  )}
                </div>
              ) : undefined
            }
          >
            {/* An available update: download it, then install it (like the Claude Code and Graphify rows) */}
            {appUpdateInfo && (
              isAppUpdateDownloaded ? (
                <Button size="sm" className="gap-1.5" onClick={handleInstallAppUpdate} disabled={showReadOnlyWarning}>
                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {t('updates.installAndRestart')}
                </Button>
              ) : (
                <Button size="sm" className="gap-1.5" onClick={handleDownloadAppUpdate} disabled={downloadingVersion !== null}>
                  {downloadingVersion === appUpdateInfo.version ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                  ) : (
                    <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                  {downloadingVersion === appUpdateInfo.version ? t('updates.downloading') : t('updates.downloadUpdate')}
                </Button>
              )
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={checkForAppUpdates}
              disabled={isCheckingAppUpdate}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isCheckingAppUpdate ? 'animate-spin' : ''}`} strokeWidth={1.75} />
              {t('updates.checkForUpdates')}
            </Button>
          </SettingsRow>

          <SettingsRow
            label={t('updates.autoUpdateProjects')}
            description={t('updates.autoUpdateProjectsDescription')}
            htmlFor="autoUpdateAutoBuild"
          >
            <Switch
              id="autoUpdateAutoBuild"
              checked={settings.autoUpdateAutoBuild}
              onCheckedChange={(checked) =>
                onSettingsChange({ ...settings, autoUpdateAutoBuild: checked })
              }
            />
          </SettingsRow>

          <SettingsRow
            label={t('updates.betaUpdates')}
            description={t('updates.betaUpdatesDescription')}
            htmlFor="betaUpdates"
            footer={
              /* Stable Downgrade - shown when user turns off beta while on prerelease */
              stableDowngradeInfo && !checkResult?.update ? (
                <div className="space-y-4 rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-foreground">{t('updates.stableDowngradeAvailable')}</p>
                      <p className="mt-0.5 text-sm text-(--nav-label-color)">
                        {t('updates.stableDowngradeDescription')}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-muted-foreground"
                      onClick={dismissStableDowngrade}
                      aria-label={t('common:accessibility.dismissAriaLabel')}
                    >
                      <X className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </div>

                  <div className="text-sm">
                    <span className="text-(--nav-label-color)">{t('updates.stableVersion')}: </span>
                    <span className="font-mono text-foreground">{stableDowngradeInfo.version}</span>
                    {stableDowngradeInfo.releaseDate && (
                      <span className="text-(--nav-label-color)">
                        {' · '}{t('updates.released')} {new Date(stableDowngradeInfo.releaseDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>

                  {/* Release Notes */}
                  {stableDowngradeInfo.releaseNotes && (
                    <div className="max-h-48 overflow-y-auto rounded-lg bg-segment-track px-4 py-3">
                      <ReleaseNotesRenderer content={stableDowngradeInfo.releaseNotes} />
                    </div>
                  )}

                  {renderDownloadProgress()}

                  {/* Action Buttons */}
                  <div className="flex gap-2">
                    {isDowngradeDownloaded ? (
                      <Button size="sm" variant="outline" onClick={handleInstallAppUpdate} disabled={showReadOnlyWarning}>
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                        {t('updates.installAndRestart')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleDownloadStableVersion}
                        disabled={downloadingVersion !== null}
                      >
                        {downloadingVersion === stableDowngradeInfo.version ? (
                          <>
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                            {t('updates.downloading')}
                          </>
                        ) : (
                          <>
                            <ArrowDownToLine className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.75} />
                            {t('updates.downloadStableVersion')}
                          </>
                        )}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={dismissStableDowngrade}>
                      {t('common:actions.dismiss')}
                    </Button>
                  </div>
                </div>
              ) : undefined
            }
          >
            <Switch
              id="betaUpdates"
              checked={settings.betaUpdates ?? false}
              onCheckedChange={(checked) => {
                onSettingsChange({ ...settings, betaUpdates: checked });
                // Other versions are eligible now: show what was last found for this setting until
                // the main process has checked again (APP_UPDATE_CHECKED)
                setCheckResult(readRefreshCache<AppUpdateCheckResult>(cacheKeyFor(checked)) ?? null);
                setDowngradeDismissed(false);
              }}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
    );
  }

  // notifications section
  const notificationItems: Array<{
    key: keyof NotificationSettings;
    labelKey: string;
    descriptionKey: string;
  }> = [
    { key: 'onTaskComplete', labelKey: 'notifications.onTaskComplete', descriptionKey: 'notifications.onTaskCompleteDescription' },
    { key: 'onTaskFailed', labelKey: 'notifications.onTaskFailed', descriptionKey: 'notifications.onTaskFailedDescription' },
    { key: 'onReviewNeeded', labelKey: 'notifications.onReviewNeeded', descriptionKey: 'notifications.onReviewNeededDescription' },
    { key: 'sound', labelKey: 'notifications.sound', descriptionKey: 'notifications.soundDescription' }
  ];

  return (
    <SettingsSection
      title={t('notifications.title')}
      description={t('notifications.description')}
    >
      <SettingsRows>
        {notificationItems.map((item) => (
          <SettingsRow
            key={item.key}
            label={t(item.labelKey)}
            description={t(item.descriptionKey)}
            htmlFor={`notification-${item.key}`}
          >
            <Switch
              id={`notification-${item.key}`}
              checked={settings.notifications[item.key]}
              onCheckedChange={(checked) =>
                onSettingsChange({
                  ...settings,
                  notifications: {
                    ...settings.notifications,
                    [item.key]: checked
                  }
                })
              }
            />
          </SettingsRow>
        ))}
      </SettingsRows>
    </SettingsSection>
  );
}
