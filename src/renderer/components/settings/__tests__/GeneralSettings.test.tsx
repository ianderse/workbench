/**
 * @vitest-environment jsdom
 */
/**
 * Paths page (Settings > Developer): the detected tools with their source, and in WSL mode the
 * tools found inside WSL ("WSL" source) with inputs that edit the Linux paths (`wslToolPaths`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { GeneralSettings } from '../GeneralSettings';
import type { AppSettings, ShellRuntimeStatus, ToolDetectionResult } from '../../../../shared/types';

const missing: ToolDetectionResult = { found: false, source: 'fallback', message: 'not found' };

const status = (overrides: Partial<ShellRuntimeStatus> = {}): ShellRuntimeStatus => ({
  supported: true,
  ready: true,
  configured: 'pwsh',
  active: 'pwsh',
  wsl: null,
  ...overrides
});

const api = {
  getCliToolsInfo: vi.fn(),
  getShellRuntimeStatus: vi.fn()
};

const renderPage = (settings: Partial<AppSettings>) => {
  const onSettingsChange = vi.fn();
  render(<GeneralSettings settings={settings as AppSettings} onSettingsChange={onSettingsChange} section="paths" />);
  return { onSettingsChange };
};

describe('GeneralSettings (Paths)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  });

  it('shows the WSL tools with the WSL source and edits the WSL paths in WSL mode', async () => {
    api.getCliToolsInfo.mockResolvedValue({
      success: true,
      data: {
        python: missing,
        git: { found: true, path: '/usr/bin/git', version: '2.43.0', source: 'wsl', message: 'Found Git in WSL (Ubuntu): /usr/bin/git' },
        gh: { found: false, source: 'wsl', message: 'GitHub CLI not installed in WSL (Ubuntu)' },
        glab: missing,
        claude: missing
      }
    });
    api.getShellRuntimeStatus.mockResolvedValue({ success: true, data: status({ configured: 'wsl', active: 'wsl', distro: 'Ubuntu' }) });

    const { onSettingsChange } = renderPage({ theme: 'dark', gitPath: 'C:\\Git\\cmd\\git.exe' });

    expect(await screen.findByText('/usr/bin/git')).toBeInTheDocument();
    expect(screen.getByText(/· WSL$/)).toBeInTheDocument();
    expect(screen.getAllByText('Not installed in WSL').length).toBeGreaterThan(0);

    // The Windows path isn't shown; the input edits the WSL set
    const gitInput = screen.getByLabelText('Git path');
    expect(gitInput).toHaveValue('');
    expect(gitInput).toHaveAttribute('placeholder', 'For example /usr/bin/git');
    fireEvent.change(gitInput, { target: { value: '/opt/git/bin/git' } });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ gitPath: 'C:\\Git\\cmd\\git.exe', wslToolPaths: { git: '/opt/git/bin/git' } })
    );
  });

  it('edits the native paths when tools run natively', async () => {
    api.getCliToolsInfo.mockResolvedValue({
      success: true,
      data: {
        python: missing,
        git: { found: true, path: 'C:\\Git\\cmd\\git.exe', version: '2.45.0', source: 'system-path', message: '' },
        gh: missing,
        glab: missing,
        claude: missing
      }
    });
    api.getShellRuntimeStatus.mockResolvedValue({ success: true, data: status() });

    const { onSettingsChange } = renderPage({ theme: 'dark', wslToolPaths: { gh: '/usr/bin/gh' } });

    expect(await screen.findByText('C:\\Git\\cmd\\git.exe')).toBeInTheDocument();
    expect(screen.getByText(/· System PATH$/)).toBeInTheDocument();

    const ghInput = screen.getByLabelText('GitHub CLI path');
    expect(ghInput).toHaveValue('');
    fireEvent.change(ghInput, { target: { value: 'C:\\gh\\gh.exe' } });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ githubCLIPath: 'C:\\gh\\gh.exe', wslToolPaths: { gh: '/usr/bin/gh' } })
    );
  });
});
