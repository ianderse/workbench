/**
 * Electron App Updater
 *
 * Finds new Workbench versions on GitHub Releases and downloads and installs them when the user
 * asks (Settings > Updates). Nothing is downloaded on its own.
 *
 * Which version: the app reads the GitHub release list and offers the highest version among the
 * eligible releases (stable ones, plus pre-releases with Beta updates on), see
 * updater/release-selection.ts. electron-updater only downloads and installs: before a download
 * its feed is pointed at that one release's files.
 *
 * Flow:
 * 1. Check 3 seconds after launch, then every 4 hours (packaged builds)
 * 2. A newly found version opens Settings > Updates in one window ("Auto-update projects" on), or
 *    shows a desktop notification that opens it when clicked
 * 3. Download, then "Install and restart", from Settings > Updates
 *
 * Events sent to renderer:
 * - APP_UPDATE_CHECKED: a check finished (AppUpdateCheckResult)
 * - APP_UPDATE_DOWNLOADED: the asked-for version is downloaded and ready to install
 * - APP_UPDATE_PROGRESS: download progress
 * - APP_UPDATE_ERROR: error during a download
 * - APP_UPDATE_OPEN_SETTINGS: open Settings > Updates (sent to one window only)
 */

import { accessSync, constants as fsConstants } from 'fs';
import path from 'path';
import semver from 'semver';
import { autoUpdater } from 'electron-updater';
import { app, net, Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import { allowWindowClose } from './app-tray';
import { freezeWindowSession } from './window-session';
import { appLog } from './app-logger';
import { safeSendToRenderer } from './ipc-handlers/utils';
import { IPC_CHANNELS } from '../shared/constants';
import type { AppUpdateCheckResult, AppUpdateInfo } from '../shared/types';
import settingsLocale from '../shared/i18n/locales/en/settings.json';
import { isMacOS } from './platform';
import { readSettingsFile } from './settings-utils';
import { showWindow } from './window-manager';
import {
  chooseUpdateOffer,
  isPrereleaseVersion,
  parseGitHubReleases,
  type PublishedRelease,
  type UpdateOffer
} from './updater/release-selection';

// GitHub repo info for API calls
const GITHUB_OWNER = 'ianderse';
const GITHUB_REPO = 'workbench-omp';
const GITHUB_API_TIMEOUT = 10000;

// Debug mode - DEBUG_UPDATER=true or development mode
const DEBUG_UPDATER = process.env.DEBUG_UPDATER === 'true' || process.env.NODE_ENV === 'development';

// Downloads only happen when the user asks; a downloaded update is installed on quit
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

if (DEBUG_UPDATER) {
  autoUpdater.logger = {
    info: (msg: string) => appLog.debug('[app-updater:debug]', msg),
    warn: (msg: string) => appLog.debug('[app-updater:debug]', msg),
    error: (msg: string) => appLog.error('[app-updater:debug]', msg),
    debug: (msg: string) => appLog.debug('[app-updater:debug]', msg)
  };
}

/** Where update events go; windows come and go, so they are resolved per event */
let getUpdateWindow: () => BrowserWindow | null = () => null;
let periodicCheckIntervalId: ReturnType<typeof setInterval> | null = null;

/** The "Beta updates" setting */
let betaUpdates = false;
/** What the last check offers (the releases behind lastCheck) */
let currentOffer: UpdateOffer | null = null;
/** The last check's result, so Settings > Updates shows it when opened (e.g. from the notification) */
let lastCheck: AppUpdateCheckResult | null = null;
let checkInFlight: Promise<AppUpdateCheckResult> | null = null;
/** The release being downloaded; only its 'update-downloaded' counts */
let downloadingRelease: PublishedRelease | null = null;
/** The downloaded update, ready to install (persists across Settings page navigations) */
let downloadedUpdateInfo: AppUpdateInfo | null = null;
/** The newest version a background check announced, so each version is announced once */
let announcedVersion: string | null = null;
/** The desktop notification, kept so it isn't garbage collected before it is clicked */
let updateNotification: Notification | null = null;

function sendUpdateEvent(channel: string, payload?: unknown): void {
  safeSendToRenderer(getUpdateWindow, channel, payload);
}

function toUpdateInfo(release: PublishedRelease): AppUpdateInfo {
  return { version: release.version, releaseNotes: release.notes, releaseDate: release.publishedAt };
}

/** The published releases (drafts left out); throws when GitHub can't be reached */
async function fetchReleases(): Promise<PublishedRelease[]> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`;
  const response = await net.fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Workbench/${getCurrentVersion()}`
    },
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT)
  });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'GitHub rate limit reached, try again later'
      : `GitHub returned HTTP ${response.status}`);
  }
  return parseGitHubReleases(await response.json());
}

async function runCheck(): Promise<AppUpdateCheckResult> {
  let releases: PublishedRelease[];
  try {
    releases = await fetchReleases();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appLog.error('[app-updater] Update check failed:', message);
    return { status: 'error', error: message };
  }

  const currentVersion = getCurrentVersion();
  const offer = chooseUpdateOffer(currentVersion, betaUpdates, releases);
  let result: AppUpdateCheckResult;
  if (offer.update) {
    result = { status: 'update-available', update: toUpdateInfo(offer.update), latestVersion: offer.update.version };
  } else if (!offer.latest) {
    result = { status: 'unpublished' };
  } else if (semver.eq(offer.latest.version, currentVersion)) {
    result = { status: 'up-to-date', latestVersion: offer.latest.version };
  } else {
    // Running a version newer than anything eligible (a local build, or a beta with Beta updates off)
    result = {
      status: 'unpublished',
      latestVersion: offer.latest.version,
      ...(offer.downgrade && { downgrade: toUpdateInfo(offer.downgrade) })
    };
  }

  currentOffer = offer;
  lastCheck = result;
  sendUpdateEvent(IPC_CHANNELS.APP_UPDATE_CHECKED, result);
  return result;
}

/**
 * Check for a newer version (Settings > Updates, launch, periodic). Reports "up-to-date" only
 * when the highest eligible release is exactly the running version.
 */
export function checkForUpdates(): Promise<AppUpdateCheckResult> {
  checkInFlight ??= runCheck().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

/** Send to one window only (never every project window), once its page has loaded */
function sendToWindow(window: BrowserWindow, channel: string): void {
  if (window.isDestroyed()) return;
  const send = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel);
  };
  if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
  else send();
}

/** Open Settings > Updates in the focused (or main) window */
function openUpdateSettings(bringToFront: boolean): void {
  const window = getUpdateWindow();
  if (!window || window.isDestroyed()) return;
  if (bringToFront) showWindow(window);
  sendToWindow(window, IPC_CHANNELS.APP_UPDATE_OPEN_SETTINGS);
}

/** A desktop notification about a new version; clicking it opens Settings > Updates */
function notifyUpdateAvailable(info: AppUpdateInfo): void {
  if (!Notification.isSupported()) return;
  updateNotification?.close();
  const text = settingsLocale.updates;
  const notification = new Notification({
    title: text.notificationTitle,
    body: text.notificationBody.replace('{{version}}', info.version)
  });
  notification.on('click', () => openUpdateSettings(true));
  updateNotification = notification;
  notification.show();
}

/**
 * Tell the user about a new version a background check found: open Settings > Updates, where its
 * Download button is ("Auto-update projects", on by default), or show a notification
 */
function announceUpdate(info: AppUpdateInfo): void {
  if (info.version === announcedVersion) return;
  announcedVersion = info.version;
  if (readSettingsFile()?.autoUpdateAutoBuild !== false) {
    openUpdateSettings(false);
  } else {
    notifyUpdateAvailable(info);
  }
}

async function backgroundCheck(announce: boolean): Promise<void> {
  try {
    const result = await checkForUpdates();
    if (announce && result.update) announceUpdate(result.update);
  } catch (error) {
    appLog.error('[app-updater] Background update check failed:', error);
  }
}

/**
 * Initialize the app updater: event handlers, the check at launch and periodic checks (packaged
 * builds; development builds check at launch and when asked, and never download)
 *
 * @param getWindow - Resolves the window update events go to
 * @param beta - The "Beta updates" setting
 */
export function initializeAppUpdater(getWindow: () => BrowserWindow | null, beta = false): void {
  getUpdateWindow = getWindow;
  betaUpdates = beta;
  // There is nothing to install an update into in a development build
  if (!app.isPackaged) autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-downloaded', (info) => {
    const release = downloadingRelease;
    if (!release || !semver.valid(info.version) || !semver.eq(info.version, release.version)) {
      appLog.warn('[app-updater] Ignoring a download that was not asked for:', info.version);
      return;
    }
    downloadingRelease = null;
    downloadedUpdateInfo = toUpdateInfo(release);
    autoUpdater.autoInstallOnAppQuit = app.isPackaged;
    sendUpdateEvent(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, downloadedUpdateInfo);
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateEvent(IPC_CHANNELS.APP_UPDATE_PROGRESS, {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    });
  });

  autoUpdater.on('error', (error) => {
    appLog.error('[app-updater] Update error:', error);
    sendUpdateEvent(IPC_CHANNELS.APP_UPDATE_ERROR, { message: error.message });
  });

  const INITIAL_DELAY = 3000;
  setTimeout(() => void backgroundCheck(true), INITIAL_DELAY);

  // Development builds check again only when asked (unless DEBUG_UPDATER is set)
  if (!app.isPackaged && process.env.DEBUG_UPDATER !== 'true') return;

  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  periodicCheckIntervalId = setInterval(() => void backgroundCheck(true), FOUR_HOURS);
}

/**
 * The "Beta updates" setting changed: forget what the last check offered and check again
 * (APP_UPDATE_CHECKED tells Settings > Updates the new result)
 */
export function setBetaUpdates(enabled: boolean): void {
  if (enabled === betaUpdates) return;
  betaUpdates = enabled;
  currentOffer = null;
  lastCheck = null;
  // A downloaded beta isn't offered any more: don't install it on quit
  if (!enabled && downloadedUpdateInfo && isPrereleaseVersion(downloadedUpdateInfo.version)) {
    downloadedUpdateInfo = null;
    autoUpdater.autoInstallOnAppQuit = false;
  }
  void backgroundCheck(false);
}

function assertCanDownload(): void {
  // A development build has nothing to install an update into
  if (!app.isPackaged) {
    throw new Error('Development builds only check for updates; they do not download them');
  }
}

/** Point electron-updater at one release's files and download them */
async function downloadRelease(release: PublishedRelease, isDowngrade: boolean): Promise<void> {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${encodeURIComponent(release.tag)}`,
    // GitHub's asset storage doesn't serve multiple ranges in one request
    useMultipleRangeRequest: false
  });
  autoUpdater.allowDowngrade = isDowngrade;
  downloadingRelease = release;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable || !semver.eq(result.updateInfo.version, release.version)) {
      throw new Error(`Version ${release.version} has no update for this platform`);
    }
    await autoUpdater.downloadUpdate();
  } catch (error) {
    downloadingRelease = null;
    appLog.error(`[app-updater] Download of ${release.version} failed:`, error);
    throw error;
  } finally {
    autoUpdater.allowDowngrade = false;
  }
}

/** Download the newer version the last check found (checks first when there was none) */
export async function downloadUpdate(): Promise<void> {
  assertCanDownload();
  if (!currentOffer) await checkForUpdates();
  const release = currentOffer?.update;
  if (!release) throw new Error('No newer version to download');
  await downloadRelease(release, false);
}

/**
 * Download the latest stable release over a running beta that is newer than it (Beta updates
 * off); "Install and restart" then goes back to stable
 */
export async function downloadStableVersion(): Promise<void> {
  assertCanDownload();
  if (!currentOffer) await checkForUpdates();
  const release = currentOffer?.downgrade;
  if (!release) throw new Error('No stable version to download');
  await downloadRelease(release, true);
}

/**
 * Check if the app is running from a read-only volume (e.g., DMG on macOS)
 * Returns true if the app cannot be updated in place
 */
function isRunningFromReadOnlyVolume(): boolean {
  if (!isMacOS()) {
    return false;
  }

  const appPath = app.getAppPath();

  // Check if the filesystem is read-only by testing write access.
  // We don't use a /Volumes/ prefix check because writable external drives
  // (USB, external SSDs) are also mounted under /Volumes/ on macOS.
  try {
    // Navigate from app.asar to the Contents/ directory (app.asar -> Resources -> Contents)
    const contentsPath = path.resolve(appPath, '..', '..');

    // Try to check if we can write to the app bundle's parent directory
    accessSync(path.dirname(contentsPath), fsConstants.W_OK);
    return false;
  } catch (error: unknown) {
    // Only treat as read-only if the filesystem itself is read-only (EROFS).
    // Permission errors (EACCES) in managed/enterprise environments should not
    // block updates — the updater may still have elevated access.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    return code === 'EROFS';
  }
}

/**
 * Quit and install the downloaded update
 * Returns false if running from a read-only volume (update cannot proceed)
 */
export function quitAndInstall(): boolean {
  if (isRunningFromReadOnlyVolume()) {
    appLog.warn('[app-updater] Cannot install: running from read-only volume');
    sendUpdateEvent(IPC_CHANNELS.APP_UPDATE_READONLY_VOLUME, {
      appPath: app.getAppPath()
    });
    return false;
  }

  appLog.warn('[app-updater] Quitting and installing update');
  freezeWindowSession(); // quitAndInstall closes the windows before before-quit fires
  allowWindowClose(); // don't let hide-to-tray block the updater from closing the window
  autoUpdater.quitAndInstall(false, true);
  return true;
}

/** The last check's result, or null when nothing was checked since launch or since Beta updates changed */
export function getLastUpdateCheck(): AppUpdateCheckResult | null {
  return lastCheck;
}

export function getCurrentVersion(): string {
  return autoUpdater.currentVersion.version;
}

/** The downloaded update, ready to install, or null */
export function getDownloadedUpdateInfo(): AppUpdateInfo | null {
  return downloadedUpdateInfo;
}

/**
 * Stop periodic update checks - called during app shutdown
 */
export function stopPeriodicUpdates(): void {
  if (periodicCheckIntervalId) {
    clearInterval(periodicCheckIntervalId);
    periodicCheckIntervalId = null;
  }
}
