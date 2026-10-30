/**
 * CLAUDE_PROFILE_SET_ACTIVE: switching the Claude account in a project window.
 *
 * Each window has its own account: the switch is saved as the window's project's account and
 * moves only that project's agent windows. Projects open in other windows without an account of
 * their own keep the one they run on, and the new account becomes the default for the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeProfile, Project } from '../../../shared/types';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const state = vi.hoisted(() => ({
  activeProfileId: 'a',
  projects: [] as Array<{ id: string; path: string; settings: Record<string, unknown> }>,
  windows: [] as Array<{ windowId: number; projectId: string | null }>,
}));
const safeSendToRenderer = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: vi.fn()
  },
  BrowserWindow: { fromWebContents: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
}));

vi.mock('../../claude-profile-manager', () => {
  const profiles: Partial<ClaudeProfile>[] = [
    { id: 'a', configDir: '/cfg/a' },
    { id: 'b', configDir: '/cfg/b' },
  ];
  const getProfile = (id: string) => profiles.find((p) => p.id === id);
  return {
    getClaudeProfileManager: () => ({
      getProfile,
      getActiveProfile: () => getProfile(state.activeProfileId),
      setActiveProfile: (id: string) => {
        if (!getProfile(id)) return false;
        state.activeProfileId = id;
        return true;
      },
    }),
  };
});
vi.mock('../../project-store', () => ({
  projectStore: {
    getProjects: () => state.projects,
    getProject: (id: string) => state.projects.find((p) => p.id === id),
    updateProjectSettings: (id: string, settings: Record<string, unknown>) => {
      const project = state.projects.find((p) => p.id === id);
      if (project) project.settings = { ...project.settings, ...settings };
      return project;
    },
  },
}));
vi.mock('../../window-manager', () => ({ listProjectWindows: () => state.windows }));
vi.mock('../utils', () => ({ safeSendToRenderer }));
vi.mock('../../settings-utils', () => ({ readSettingsFileAsync: vi.fn(async () => ({})) }));
vi.mock('../../claude-profile/usage-monitor', () => ({ getUsageMonitor: vi.fn() }));
vi.mock('../../terminal-manager', () => ({ TerminalManager: class {} }));
vi.mock('../../claude-profile/session-utils', () => ({ migrateSession: vi.fn() }));
vi.mock('../../terminal/session-handler', () => ({ findMostRecentClaudeSession: vi.fn() }));
vi.mock('../../claude-profile/profile-utils', () => ({ createProfileDirectory: vi.fn() }));
vi.mock('../../utils/config-path-validator', () => ({ isValidConfigDir: vi.fn(() => true) }));
vi.mock('../../cli-tool-manager', () => ({ getToolInfoAsync: vi.fn() }));
vi.mock('../../claude-profile/config-dir-paths', () => ({ isDefaultClaudeConfigDir: vi.fn(() => false) }));
vi.mock('../claude-code-handlers', () => ({ openTerminalWithCommand: vi.fn() }));

import { IPC_CHANNELS } from '../../../shared/constants';
import type { AgentManager } from '../../agent/agent-manager';
import type { TerminalManager } from '../../terminal-manager';
import { registerTerminalHandlers } from '../terminal-handlers';

interface Window {
  id: string;
  projectPath?: string;
  claudeProfileId?: string;
}

const moveAgentWindowToAccount = vi.fn(async () => undefined);

/** Register the handlers over the given agent windows and return the switch */
function given(windows: Window[]): (profileId: string, projectId?: string) => Promise<{ success: boolean }> {
  handlers.clear();
  registerTerminalHandlers(
    {
      getTerminalsForProfileChange: () => windows.map((w) => ({ ...w, cwd: w.projectPath ?? '/', isCLIMode: true })),
      moveAgentWindowToAccount,
    } as unknown as TerminalManager,
    () => null,
    {} as AgentManager
  );
  const handler = handlers.get(IPC_CHANNELS.CLAUDE_PROFILE_SET_ACTIVE);
  if (!handler) throw new Error('the switch handler was not registered');
  return async (profileId, projectId) => (await handler({}, profileId, projectId)) as { success: boolean };
}

const project = (id: string, settings: Record<string, unknown> = {}) => ({ id, path: `/projects/${id}`, settings });
const settingsOf = (id: string) => (state.projects.find((p) => p.id === id) as Project | undefined)?.settings;

describe('switching the Claude account in a window', () => {
  beforeEach(() => {
    state.activeProfileId = 'a';
    state.projects = [project('p1'), project('p2'), project('p3', { claudeProfileId: 'a' })];
    state.windows = [{ windowId: 1, projectId: 'p1' }, { windowId: 2, projectId: 'p2' }];
    moveAgentWindowToAccount.mockClear();
    safeSendToRenderer.mockClear();
  });

  it('saves the account for the window\'s project and makes it the default', async () => {
    const result = await given([])('b', 'p1');

    expect(result.success).toBe(true);
    expect(settingsOf('p1')?.claudeProfileId).toBe('b');
    expect(state.activeProfileId).toBe('b');
  });

  it('moves only that project\'s agent windows', async () => {
    await given([
      { id: 't1', projectPath: '/projects/p1', claudeProfileId: 'a' },
      { id: 't2', projectPath: '/projects/p2', claudeProfileId: 'a' },
      { id: 't3', projectPath: '/projects/p3', claudeProfileId: 'a' },
    ])('b', 'p1');

    expect(moveAgentWindowToAccount).toHaveBeenCalledTimes(1);
    expect(moveAgentWindowToAccount).toHaveBeenCalledWith('t1', 'b', '/cfg/b');
  });

  it('leaves the project\'s windows already on the account where they are', async () => {
    state.projects[0].settings.claudeProfileId = 'b';
    await given([
      { id: 't1', projectPath: '/projects/p1', claudeProfileId: 'b' },
      // Started before the window recorded its account: on the project's account
      { id: 't2', projectPath: '/projects/p1' },
    ])('b', 'p1');

    expect(moveAgentWindowToAccount).not.toHaveBeenCalled();
  });

  it('keeps projects open in other windows on the account they run on', async () => {
    await given([])('b', 'p1');

    // p2 had no account of its own: it stays on the one that was in use
    expect(settingsOf('p2')?.claudeProfileId).toBe('a');
    expect(safeSendToRenderer).toHaveBeenCalledWith(expect.any(Function), IPC_CHANNELS.PROJECT_LIST_CHANGED);
    // p3 is not open in a window, and has its own account anyway
    expect(settingsOf('p3')?.claudeProfileId).toBe('a');
  });

  it('without a project, moves only the windows of projects with no account of their own', async () => {
    await given([
      { id: 't1', projectPath: '/projects/p1', claudeProfileId: 'a' },
      { id: 't3', projectPath: '/projects/p3', claudeProfileId: 'a' },
    ])('b');

    expect(state.activeProfileId).toBe('b');
    expect(moveAgentWindowToAccount).toHaveBeenCalledTimes(1);
    expect(moveAgentWindowToAccount).toHaveBeenCalledWith('t1', 'b', '/cfg/b');
    expect(settingsOf('p1')?.claudeProfileId).toBeUndefined();
  });

  it('refuses an account that does not exist', async () => {
    const result = await given([])('missing', 'p1');

    expect(result.success).toBe(false);
    expect(settingsOf('p1')?.claudeProfileId).toBeUndefined();
    expect(state.activeProfileId).toBe('a');
  });
});
