/**
 * Settings handlers and WSL tool paths: SETTINGS_GET keeps the Linux paths in `wslToolPaths`
 * (only Windows paths and empty values are dropped from that set), still clears Linux paths from
 * the native fields, and passes both sets to the tool manager.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: vi.fn()
  },
  dialog: {},
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false },
  shell: {},
  session: {},
  BrowserWindow: { fromWebContents: vi.fn() }
}));

const fsMock = vi.hoisted(() => ({ writeFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), statSync: vi.fn() }));
vi.mock('fs', () => fsMock);

const saved = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../settings-utils', () => ({
  getSettingsPath: () => '/tmp/settings.json',
  readSettingsFile: () => saved.value
}));

const tools = vi.hoisted(() => ({
  configureTools: vi.fn(),
  getToolInfo: vi.fn(),
  getToolInfoAsync: vi.fn(),
  // The test runs on Linux/macOS or Windows; treat Linux paths as wrong for native fields, like on Windows
  isPathFromWrongPlatform: vi.fn((p: string | undefined) => !!p && p.startsWith('/')),
  preWarmToolCache: vi.fn(() => Promise.resolve())
}));
vi.mock('../../cli-tool-manager', () => tools);

vi.mock('../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../app-language', () => ({ setAppLanguage: vi.fn() }));
vi.mock('../../app-updater', () => ({ setBetaUpdates: vi.fn() }));
vi.mock('../../services/task-queue', () => ({ taskQueue: { request: vi.fn() } }));
vi.mock('../../utils/git-exec', () => ({ git: vi.fn() }));

import { IPC_CHANNELS } from '../../../shared/constants';
import type { AppSettings, IPCResult } from '../../../shared/types';
import { registerSettingsHandlers } from '../settings-handlers';
import type { AgentManager } from '../../agent';

registerSettingsHandlers({} as AgentManager, () => null);

async function getSettings(): Promise<AppSettings> {
  const handler = handlers.get(IPC_CHANNELS.SETTINGS_GET);
  if (!handler) throw new Error('SETTINGS_GET not registered');
  const result = (await handler({})) as IPCResult<AppSettings>;
  if (!result.success || !result.data) throw new Error('SETTINGS_GET failed');
  return result.data;
}

describe('settings handlers: WSL tool paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Linux paths in wslToolPaths and passes both sets to the tool manager', async () => {
    saved.value = {
      gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
      wslToolPaths: { git: '/usr/bin/git', claude: '/home/me/.local/bin/claude' }
    };

    const settings = await getSettings();

    expect(settings.wslToolPaths).toEqual({ git: '/usr/bin/git', claude: '/home/me/.local/bin/claude' });
    expect(settings.gitPath).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(tools.configureTools).toHaveBeenCalledWith(
      expect.objectContaining({
        gitPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
        wslToolPaths: { git: '/usr/bin/git', claude: '/home/me/.local/bin/claude' }
      })
    );
  });

  it('drops Windows paths and empty values from wslToolPaths, and Linux paths from the native fields', async () => {
    saved.value = {
      gitPath: '/usr/bin/git',
      wslToolPaths: { git: 'C:\\Git\\git.exe', gh: '', python: '/usr/bin/python3' }
    };

    const settings = await getSettings();

    expect(settings.gitPath).toBeUndefined();
    expect(settings.wslToolPaths).toEqual({ python: '/usr/bin/python3' });
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('removes wslToolPaths when nothing usable is left', async () => {
    saved.value = { wslToolPaths: { gh: '\\\\server\\gh' } };

    const settings = await getSettings();

    expect(settings.wslToolPaths).toBeUndefined();
  });

  it('configures the tools again when only the WSL paths change', async () => {
    saved.value = {};
    const handler = handlers.get(IPC_CHANNELS.SETTINGS_SAVE);
    if (!handler) throw new Error('SETTINGS_SAVE not registered');

    await handler({}, { wslToolPaths: { git: '/opt/git/bin/git' } });

    expect(tools.configureTools).toHaveBeenCalledWith(
      expect.objectContaining({ wslToolPaths: { git: '/opt/git/bin/git' } })
    );
  });
});
