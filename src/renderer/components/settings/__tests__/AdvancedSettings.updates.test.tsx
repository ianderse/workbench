/**
 * @vitest-environment jsdom
 */
/**
 * Settings > Updates: the version found shows Download, and Install and restart only once that very
 * version is downloaded (an older downloaded file never gets an Install button next to a newer one).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { AdvancedSettings } from '../AdvancedSettings';
import { DEFAULT_APP_SETTINGS } from '../../../../shared/constants';
import type { AppSettings, AppUpdateCheckResult, AppUpdateInfo } from '../../../../shared/types';

let lastCheck: AppUpdateCheckResult | null = null;
let downloaded: AppUpdateInfo | null = null;
let onDownloaded: ((info: AppUpdateInfo) => void) | null = null;

const api = {
  getDownloadedAppUpdate: vi.fn(async () => ({ success: true, data: downloaded })),
  getLastAppUpdateCheck: vi.fn(async () => ({ success: true, data: lastCheck })),
  checkAppUpdate: vi.fn(async () => ({ success: true, data: { status: 'up-to-date' } })),
  downloadAppUpdate: vi.fn(async () => ({ success: true })),
  downloadStableUpdate: vi.fn(async () => {
    downloaded = { version: '1.3.0' };
    onDownloaded?.({ version: '1.3.0' });
    return { success: true };
  }),
  installAppUpdate: vi.fn(),
  onAppUpdateChecked: () => () => {},
  onAppUpdateDownloaded: (callback: (info: AppUpdateInfo) => void) => {
    onDownloaded = callback;
    return () => {};
  },
  onAppUpdateProgress: () => () => {},
  onAppUpdateReadOnlyVolume: () => () => {},
  onAppUpdateError: () => () => {}
};

const settings = { ...DEFAULT_APP_SETTINGS } as AppSettings;

function renderUpdates(version: string) {
  return render(
    <AdvancedSettings settings={settings} onSettingsChange={vi.fn()} section="updates" version={version} />
  );
}

describe('AdvancedSettings updates', () => {
  beforeEach(() => {
    localStorage.clear();
    lastCheck = null;
    downloaded = null;
    onDownloaded = null;
    vi.clearAllMocks();
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  });

  it('shows Download, not Install, for a newer version than the downloaded one', async () => {
    downloaded = { version: '1.4.0' };
    lastCheck = { status: 'update-available', update: { version: '1.5.0' }, latestVersion: '1.5.0' };
    renderUpdates('1.3.0');

    expect(await screen.findByRole('button', { name: /download update/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /install and restart/i })).not.toBeInTheDocument();
    // The main process's last check is used; nothing is fetched on open
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
  });

  it('shows Install and restart for the version that was downloaded', async () => {
    downloaded = { version: '1.5.0' };
    lastCheck = { status: 'update-available', update: { version: '1.5.0' }, latestVersion: '1.5.0' };
    renderUpdates('1.3.0');

    expect(await screen.findByRole('button', { name: /install and restart/i })).toBeInTheDocument();
  });

  it('downloads the stable from a beta and then offers to install it', async () => {
    lastCheck = { status: 'unpublished', latestVersion: '1.3.0', downgrade: { version: '1.3.0' } };
    renderUpdates('1.4.0-beta.2');

    const download = await screen.findByRole('button', { name: /download stable version/i });
    await act(async () => {
      fireEvent.click(download);
    });

    expect(api.downloadStableUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /install and restart/i })).toBeEnabled());
    expect(screen.queryByText(/downloading/i)).not.toBeInTheDocument();
  });
});
