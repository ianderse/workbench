/**
 * The "Live agent" setting: off by default, saved like the other app settings, and saving it
 * starts or stops the relay
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

const { settingsFile, setEnabled } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'live-agent-settings-'));
  return { settingsFile: nodePath.join(dir, 'settings.json'), setEnabled: vi.fn() };
});

vi.mock('../../settings-utils', () => ({
  getSettingsPath: () => settingsFile,
  readSettingsFile: () => {
    const fsModule = require('fs') as typeof import('fs');
    return fsModule.existsSync(settingsFile) ? JSON.parse(fsModule.readFileSync(settingsFile, 'utf-8')) : undefined;
  },
}));
vi.mock('../../live-agent/live-agent-relay', () => ({ liveAgentRelay: { setEnabled } }));
vi.mock('../../app-language', () => ({ setAppLanguage: vi.fn() }));
vi.mock('../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../app-updater', () => ({ setUpdateChannel: vi.fn(), setUpdateChannelWithDowngradeCheck: vi.fn() }));
vi.mock('../../services/task-queue', () => ({ taskQueue: { request: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({
  configureTools: vi.fn(),
  getToolPath: vi.fn(),
  getToolInfo: vi.fn(),
  getToolInfoAsync: vi.fn(),
  isPathFromWrongPlatform: vi.fn(() => false),
  preWarmToolCache: vi.fn(() => Promise.resolve()),
}));

import { DEFAULT_APP_SETTINGS, IPC_CHANNELS } from '../../../shared/constants';
import { registerSettingsHandlers } from '../settings-handlers';

type MockIpcMain = typeof ipcMain & { invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown> };
const save = (settings: Record<string, unknown>) =>
  (ipcMain as MockIpcMain).invokeHandler(IPC_CHANNELS.SETTINGS_SAVE, {}, settings);
const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));

describe('Live agent setting', () => {
  beforeEach(() => {
    setEnabled.mockClear();
    fs.rmSync(settingsFile, { force: true });
    registerSettingsHandlers({} as never, () => null);
  });

  afterAll(() => {
    fs.rmSync(path.dirname(settingsFile), { recursive: true, force: true });
  });

  it('is off by default', () => {
    expect(DEFAULT_APP_SETTINGS.liveAgent).toBe(false);
  });

  it('is saved and starts the relay when switched on', async () => {
    await expect(save({ liveAgent: true })).resolves.toEqual({ success: true });
    expect(saved().liveAgent).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it('is saved and stops the relay when switched off', async () => {
    await save({ liveAgent: true });
    await save({ liveAgent: false });
    expect(saved().liveAgent).toBe(false);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('leaves the relay alone when other settings are saved', async () => {
    await save({ maxTerminals: 6 });
    expect(saved().liveAgent).toBe(false);
    expect(setEnabled).not.toHaveBeenCalled();
  });
});
