import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mocks = vi.hoisted(() => ({
  releases: [] as unknown[],
  currentVersion: '1.4.0-beta.2',
  settings: {} as Record<string, unknown>,
  sent: [] as Array<{ channel: string; payload: unknown }>,
  notifications: [] as Array<{ title: string; body: string }>
}));

vi.mock('electron', () => {
  class FakeNotification {
    static isSupported = () => true;
    constructor(options: { title: string; body: string }) {
      mocks.notifications.push(options);
    }
    on() {}
    show() {}
    close() {}
  }
  return {
    app: { isPackaged: true, getAppPath: () => '/app' },
    net: {
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => mocks.releases }))
    },
    Notification: FakeNotification
  };
});

vi.mock('electron-updater', async () => {
  const { EventEmitter: Emitter } = await import('events');
  const updater = Object.assign(new Emitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    logger: null,
    currentVersion: { get version() { return mocks.currentVersion; } },
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn()
  });
  return { autoUpdater: updater };
});

vi.mock('../ipc-handlers/utils', () => ({
  safeSendToRenderer: (_getWindow: unknown, channel: string, payload: unknown) => {
    mocks.sent.push({ channel, payload });
    return true;
  }
}));
vi.mock('../app-tray', () => ({ allowWindowClose: vi.fn() }));
vi.mock('../app-logger', () => ({ appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => mocks.settings }));
vi.mock('../window-manager', () => ({ showWindow: vi.fn() }));
vi.mock('../platform', () => ({ isMacOS: () => false }));

import { autoUpdater } from 'electron-updater';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  checkForUpdates,
  downloadStableVersion,
  downloadUpdate,
  getDownloadedUpdateInfo,
  getLastUpdateCheck,
  initializeAppUpdater,
  setBetaUpdates
} from '../app-updater';

type FakeUpdater = EventEmitter & {
  allowDowngrade: boolean;
  setFeedURL: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
};
const updater = autoUpdater as unknown as FakeUpdater;

function ghRelease(version: string, prerelease = version.includes('-')) {
  return { tag_name: `v${version}`, prerelease, draft: false, body: `Notes for ${version}` };
}

/** electron-updater behaves as if the feed holds `version`; download emits update-downloaded */
function serveFromFeed(version: string) {
  updater.checkForUpdates.mockImplementation(async () => {
    const newer = version !== mocks.currentVersion;
    const allowed = newer && (updater.allowDowngrade || version > mocks.currentVersion);
    return { isUpdateAvailable: allowed, updateInfo: { version } };
  });
  updater.downloadUpdate.mockImplementation(async () => {
    updater.emit('update-downloaded', { version });
    return [`/tmp/Workbench-${version}.deb`];
  });
}

/** A window that records what was sent to it */
function fakeWindow() {
  const sent: string[] = [];
  return {
    sent,
    window: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, isLoading: () => false, send: (channel: string) => sent.push(channel) }
    }
  };
}

const focused = fakeWindow();

describe('app updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sent.length = 0;
    mocks.notifications.length = 0;
    mocks.settings = {};
    updater.setFeedURL.mockClear();
    updater.checkForUpdates.mockReset();
    updater.downloadUpdate.mockReset();
  });

  it('initializes once with Beta updates on', () => {
    updater.removeAllListeners();
    initializeAppUpdater(() => focused.window as never, true);
  });

  it('offers the highest eligible version, not the newest published one', async () => {
    mocks.currentVersion = '1.3.0';
    // A 1.3.1 hotfix published after the 1.4.0 beta
    mocks.releases = [ghRelease('1.3.1'), ghRelease('1.4.0-beta.1'), ghRelease('1.3.0')];
    const result = await checkForUpdates();
    expect(result.status).toBe('update-available');
    expect(result.update?.version).toBe('1.4.0-beta.1');
    expect(getLastUpdateCheck()).toEqual(result);
    expect(mocks.sent.some((event) => event.channel === IPC_CHANNELS.APP_UPDATE_CHECKED)).toBe(true);
  });

  it('downloads exactly the offered release and reports it downloaded', async () => {
    serveFromFeed('1.4.0-beta.1');
    await downloadUpdate();
    expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'generic',
      url: 'https://github.com/ianderse/workbench-omp/releases/download/v1.4.0-beta.1'
    }));
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getDownloadedUpdateInfo()?.version).toBe('1.4.0-beta.1');
    expect(mocks.sent.find((event) => event.channel === IPC_CHANNELS.APP_UPDATE_DOWNLOADED)?.payload)
      .toMatchObject({ version: '1.4.0-beta.1' });
  });

  it('keeps the version found when settings are saved without changing Beta updates', () => {
    const before = getLastUpdateCheck();
    setBetaUpdates(true);
    expect(getLastUpdateCheck()).toBe(before);
  });

  it('downloads the stable when a beta user turns Beta updates off, and it can be installed', async () => {
    mocks.currentVersion = '1.4.0-beta.2';
    mocks.releases = [ghRelease('1.4.0-beta.2'), ghRelease('1.3.0'), ghRelease('1.2.0')];

    setBetaUpdates(false);
    // The downloaded beta isn't offered any more
    expect(getDownloadedUpdateInfo()).toBeNull();
    await vi.waitFor(() => expect(getLastUpdateCheck()).not.toBeNull());
    const check = getLastUpdateCheck();
    expect(check?.status).toBe('unpublished');
    expect(check?.downgrade?.version).toBe('1.3.0');

    serveFromFeed('1.3.0');
    await downloadStableVersion();

    expect(updater.setFeedURL).toHaveBeenLastCalledWith(expect.objectContaining({
      url: 'https://github.com/ianderse/workbench-omp/releases/download/v1.3.0'
    }));
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getDownloadedUpdateInfo()).toMatchObject({ version: '1.3.0', releaseNotes: 'Notes for 1.3.0' });
    // The downgrade is only allowed for that download
    expect(updater.allowDowngrade).toBe(false);
  });

  it('fails instead of pretending to download when the feed has no update for the platform', async () => {
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.3.0' } });
    await expect(downloadStableVersion()).rejects.toThrow(/1\.3\.0/);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('ignores a downloaded file that was not asked for', () => {
    updater.emit('update-downloaded', { version: '9.9.9' });
    expect(getDownloadedUpdateInfo()?.version).toBe('1.3.0');
  });

  it('opens Settings > Updates in one window when the launch check finds a new version', async () => {
    mocks.currentVersion = '1.3.0';
    mocks.releases = [ghRelease('1.5.0'), ghRelease('1.3.0')];
    updater.removeAllListeners();
    initializeAppUpdater(() => focused.window as never, false);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(focused.sent).toContain(IPC_CHANNELS.APP_UPDATE_OPEN_SETTINGS));
    // Sent to that window directly, not broadcast to every project window
    expect(mocks.sent.some((event) => event.channel === IPC_CHANNELS.APP_UPDATE_OPEN_SETTINGS)).toBe(false);
    expect(mocks.notifications).toHaveLength(0);
  });

  it('shows a notification instead when "Auto-update projects" is off', async () => {
    mocks.settings = { autoUpdateAutoBuild: false };
    mocks.releases = [ghRelease('1.6.0'), ghRelease('1.3.0')];
    const opened = focused.sent.length;
    updater.removeAllListeners();
    initializeAppUpdater(() => focused.window as never, false);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(mocks.notifications).toHaveLength(1));
    expect(mocks.notifications[0]).toEqual({
      title: 'Workbench update available',
      body: 'Version 1.6.0 is ready to download'
    });
    expect(focused.sent.length).toBe(opened);
  });
});
