import { ipcMain, dialog, app, shell, session, BrowserWindow } from 'electron';
import { existsSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { spawn } from 'node:child_process';
import path from 'path';

import { IPC_CHANNELS, DEFAULT_APP_SETTINGS, SPELL_CHECK_LANGUAGE_MAP, DEFAULT_SPELL_CHECK_LANGUAGE, sanitizeColorTheme } from '../../shared/constants';
import { setAppLanguage } from '../app-language';
import type {
  AppSettings,
  IPCResult
} from '../../shared/types';
import { AgentManager } from '../agent';
import { appLog } from '../app-logger';
import { setUpdateChannel, setUpdateChannelWithDowngradeCheck } from '../app-updater';
import { getSettingsPath, readSettingsFile } from '../settings-utils';
import { taskQueue } from '../services/task-queue';
import { configureTools, getToolInfo, getToolInfoAsync, isPathFromWrongPlatform, preWarmToolCache, type ToolConfig } from '../cli-tool-manager';
import { isMacOS, isWindows } from '../platform';
import { git } from '../utils/git-exec';
import { getWslInfo, reprobeWslTools } from '../platform/shell-runtime';
import { getWslExePath } from '../platform/wsl-detect';

const settingsPath = getSettingsPath();

/** Settings from the removed multi-provider account system */
const LEGACY_PROVIDER_SETTING_KEYS = [
  'providerAccounts',
  'globalPriorityOrder',
  'crossProviderPriorityOrder',
  'modelOverrides',
  'providerAgentConfig',
  'customMixedPhaseConfig',
  '_migratedProviderAccounts',
  '_migratedToPerProviderConfig',
] as const;

/** CLI tool paths from settings: both sets, the tool manager uses the WSL set while tools run in WSL */
function toolConfigFromSettings(settings: Partial<AppSettings>): ToolConfig {
  return {
    pythonPath: settings.pythonPath,
    gitPath: settings.gitPath,
    githubCLIPath: settings.githubCLIPath,
    gitlabCLIPath: settings.gitlabCLIPath,
    claudePath: settings.claudePath,
    wslToolPaths: settings.wslToolPaths,
  };
}

/**
 * How long an emulator is watched after it starts before it counts as open.
 *
 * The walk through the Linux emulators below has to tell "installed and working" from "installed
 * but unable to open a window", which is what an emulator does with no DISPLAY or no session bus:
 * it starts and exits non-zero within a few tens of milliseconds. Waiting a little covers that
 * without waiting on a window that stays up, which only closes when the user closes it, so the
 * handler still answers in well under a second even when every candidate fails in turn.
 */
const TERMINAL_STARTUP_GRACE_MS = 400;

/**
 * Open a terminal emulator and leave it running.
 *
 * The window outlives this call, so the program is started detached and let go of rather than
 * waited for: `cmd /K` and xterm only return when the user closes the window, and waiting for that
 * from an IPC handler froze the whole app. The promise answers whether the program opened a
 * window, which is what the walk through the Linux emulators below needs, and nothing more: it
 * rejects when the program cannot be started at all and when it gives up during the grace period,
 * and resolves once that period passes with the program still up, or earlier if it exits cleanly
 * (an emulator that hands the window to a server of its own, such as gnome-terminal, returns
 * straight away with status 0).
 *
 * An emulator slower to give up than the grace period has therefore already been reported as
 * open, and that answer cannot be taken back. Nothing is started in its place either, because by
 * then a failure cannot be told from the user closing a window whose shell happened to end badly:
 * the child is detached with its output discarded, so no exit code, signal or stream here
 * separates the two, and starting the next emulator on a guess would put a window on the screen
 * seconds after the user deliberately closed one. The failures that really do leave the screen
 * empty are not in that blind spot anyway - no display and no session bus are decided in tens of
 * milliseconds, well inside the grace period, while a hung D-Bus activation only gives up after
 * GDBus's 25 s default, far beyond any wait worth holding the user in - so what is left to do
 * with a late failure is leave a trace of it. Both ways an emulator can fail are logged, with how
 * long it lasted, which is what makes a window that never appeared explainable afterwards.
 */
function openTerminalWindow(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      if (error) reject(error);
      else resolve();
    };
    const grace = setTimeout(() => settle(), TERMINAL_STARTUP_GRACE_MS);
    // The window is on its own from here: neither the child nor this timer may hold the app open
    grace.unref();
    /**
     * A failure that only showed after the grace period, when `success` has already been
     * answered. All that is left is to leave a trace of it, so that a user reporting a terminal
     * that never opened can be answered from the log. How long the program lasted goes in the
     * line because it is the one thing that tells the two readings apart for a human: a quarter
     * of a minute points at an emulator that gave up on its own, hours at a window that was used
     * and then closed on a shell that had failed. Both ways an emulator can fail come through
     * here: it can exit non-zero, and it can report that it could not be started at all, which is
     * just as late and just as invisible.
     */
    const lateFailure = (what: string): void => {
      appLog.warn(`[Terminal] ${command} was reported as open, then ${what} after ${Date.now() - startedAt} ms`);
    };
    child.once('error', (error: Error) => {
      // Within the grace period this is the ENOENT of an emulator that is not installed, which
      // the walk needs as its answer so it can move straight on to the next candidate
      if (!settled) {
        settle(error);
        return;
      }
      lateFailure(`failed to start: ${error.message}`);
    });
    child.once('spawn', () => child.unref());
    child.once('exit', (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      const status = signal ? `on ${signal}` : `with code ${code ?? 1}`;
      if (!settled) {
        settle(new Error(`${command} exited ${status}`));
        return;
      }
      lateFailure(`exited ${status}`);
    });
  });
}

/**
 * Register all settings-related IPC handlers
 */
export function registerSettingsHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Settings Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET,
    async (): Promise<IPCResult<AppSettings>> => {
      // Load settings using shared helper and merge with defaults
      const savedSettings = readSettingsFile();
      const settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };
      let needsSave = false;

      // Migration: Drop multi-provider account settings (all AI work runs through Claude Code now).
      // providerAccounts held copies of API keys and OAuth tokens, so don't leave them on disk.
      const rawSettings = settings as unknown as Record<string, unknown>;
      for (const key of LEGACY_PROVIDER_SETTING_KEYS) {
        if (key in rawSettings) {
          delete rawSettings[key];
          needsSave = true;
        }
      }

      // Migration: Reset color themes that no longer exist (removed in earlier releases) to 'default'
      const sanitizedColorTheme = sanitizeColorTheme(settings.colorTheme);
      if (settings.colorTheme !== undefined && settings.colorTheme !== sanitizedColorTheme) {
        settings.colorTheme = sanitizedColorTheme;
        needsSave = true;
      }

      // Migration: Clear CLI tool paths that are from a different platform
      // Fixes issue where Windows paths persisted on macOS (and vice versa)
      // when settings were synced/transferred between platforms
      const pathFields = ['pythonPath', 'gitPath', 'githubCLIPath', 'gitlabCLIPath', 'claudePath', 'autoBuildPath'] as const;
      for (const field of pathFields) {
        const pathValue = settings[field];
        if (pathValue && isPathFromWrongPlatform(pathValue)) {
          console.warn(
            `[SETTINGS_GET] Clearing ${field} - path from different platform: ${pathValue}`
          );
          delete settings[field];
          needsSave = true;
        }
      }

      // Migration: WSL tool paths are Linux paths (used while tools run in WSL); drop Windows
      // paths and empty values so the two sets never mix
      if (settings.wslToolPaths) {
        const wslToolPaths = { ...settings.wslToolPaths };
        for (const [tool, value] of Object.entries(wslToolPaths) as [keyof typeof wslToolPaths, string | undefined][]) {
          if (!value?.trim() || /^[A-Za-z]:|\\/.test(value)) {
            delete wslToolPaths[tool];
            needsSave = true;
          }
        }
        if (Object.keys(wslToolPaths).length > 0) {
          settings.wslToolPaths = wslToolPaths;
        } else {
          delete settings.wslToolPaths;
          needsSave = true;
        }
      }

      // Persist migration changes
      if (needsSave) {
        try {
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        } catch (error) {
          console.error('[SETTINGS_GET] Failed to persist migration:', error);
          // Continue anyway - settings will be migrated in-memory for this session
        }
      }

      // Configure CLI tools with current settings (the WSL set is used while tools run in WSL)
      configureTools(toolConfigFromSettings(settings));

      // Re-warm cache asynchronously after configuring (non-blocking)
      preWarmToolCache(['claude']).catch((error) => {
        console.warn('[SETTINGS_GET] Failed to re-warm CLI cache:', error);
      });

      return { success: true, data: settings as AppSettings };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE,
    async (_, settings: Partial<AppSettings>): Promise<IPCResult> => {
      try {
        // Load current settings using shared helper
        const savedSettings = readSettingsFile();
        const currentSettings = { ...DEFAULT_APP_SETTINGS, ...savedSettings };

        // skippedUpdateVersion/updateRemindAfter are owned by the app updater
        const {
          skippedUpdateVersion: _skipped,
          updateRemindAfter: _remindAfter,
          ...safeSettings
        } = settings;
        const newSettings = { ...currentSettings, ...safeSettings };

        writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), 'utf-8');

        // Configure CLI tools if any paths changed
        if (
          settings.pythonPath !== undefined ||
          settings.gitPath !== undefined ||
          settings.githubCLIPath !== undefined ||
          settings.gitlabCLIPath !== undefined ||
          settings.claudePath !== undefined ||
          settings.wslToolPaths !== undefined
        ) {
          configureTools(toolConfigFromSettings(newSettings));

          // Re-warm cache asynchronously after configuring (non-blocking)
          preWarmToolCache(['claude']).catch((error) => {
            console.warn('[SETTINGS_SAVE] Failed to re-warm CLI cache:', error);
          });
        }

        // A higher parallel task limit frees slots for queued tasks
        if (settings.maxParallelTasks !== undefined) {
          taskQueue.request();
        }

        // Update auto-updater channel if betaUpdates setting changed
        if (settings.betaUpdates !== undefined) {
          if (settings.betaUpdates) {
            // Enabling beta updates - just switch channel
            setUpdateChannel('beta');
          } else {
            // Disabling beta updates - switch to stable and check if downgrade is available
            // This will notify the renderer if user is on a prerelease and stable version exists
            setUpdateChannelWithDowngradeCheck('latest', true).catch((err) => {
              console.error('[settings-handlers] Failed to check for stable downgrade:', err);
            });
          }
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save settings'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET_CLI_TOOLS_INFO,
    async (_event, options?: { refresh?: boolean }): Promise<IPCResult<{
      python: ReturnType<typeof getToolInfo>;
      git: ReturnType<typeof getToolInfo>;
      gh: ReturnType<typeof getToolInfo>;
      glab: ReturnType<typeof getToolInfo>;
      claude: ReturnType<typeof getToolInfo>;
    }>> => {
      try {
        // Detected asynchronously at app start (warmToolInfo) and reused, so this doesn't block.
        // A refresh (tools installed since) detects again; in WSL it also looks the tools up in
        // the distribution again, which is what Claude Code runs and MCP checks use
        const refresh = options?.refresh === true;
        if (refresh) await reprobeWslTools();
        const [python, git, gh, glab, claude] = await Promise.all([
          getToolInfoAsync('python', { refresh }),
          getToolInfoAsync('git', { refresh }),
          getToolInfoAsync('gh', { refresh }),
          getToolInfoAsync('glab', { refresh }),
          getToolInfoAsync('claude', { refresh }),
        ]);
        return { success: true, data: { python, git, gh, glab, claude } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get CLI tools info',
        };
      }
    }
  );

  // ============================================
  // Dialog Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_DIRECTORY,
    async (event): Promise<string | null> => {
      // Parent the picker to the window that asked, not to whichever window has focus
      const window = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      if (!window) return null;

      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Select Project Directory'
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_CREATE_PROJECT_FOLDER,
    async (
      _,
      location: string,
      name: string,
      initGit: boolean
    ): Promise<IPCResult<{ path: string; name: string; gitInitialized: boolean }>> => {
      try {
        // Validate inputs
        if (!location || !name) {
          return { success: false, error: 'Location and name are required' };
        }

        // Sanitize project name (convert to kebab-case, remove invalid chars)
        const sanitizedName = name
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-_]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');

        if (!sanitizedName) {
          return { success: false, error: 'Invalid project name' };
        }

        const projectPath = path.join(location, sanitizedName);

        // Check if folder already exists
        if (existsSync(projectPath)) {
          return { success: false, error: `Folder "${sanitizedName}" already exists at this location` };
        }

        // Create the directory
        mkdirSync(projectPath, { recursive: true });

        // Initialize git if requested
        let gitInitialized = false;
        if (initGit) {
          try {
            await git(['init'], { cwd: projectPath });
            gitInitialized = true;
          } catch {
            // Git init failed, but folder was created - continue without git
            console.warn('Failed to initialize git repository');
          }
        }

        return {
          success: true,
          data: {
            path: projectPath,
            name: sanitizedName,
            gitInitialized
          }
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create project folder'
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_GET_DEFAULT_PROJECT_LOCATION,
    async (): Promise<string | null> => {
      try {
        // Return user's home directory + common project folders
        const homeDir = app.getPath('home');
        const commonPaths = [
          path.join(homeDir, 'Projects'),
          path.join(homeDir, 'Developer'),
          path.join(homeDir, 'Code'),
          path.join(homeDir, 'Documents')
        ];

        // Return the first one that exists, or Documents as fallback
        for (const p of commonPaths) {
          if (existsSync(p)) {
            return p;
          }
        }

        return path.join(homeDir, 'Documents');
      } catch {
        return null;
      }
    }
  );

  // ============================================
  // App Info
  // ============================================

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, async (): Promise<string> => {
    // Return the actual bundled version from package.json
    const version = app.getVersion();
    console.log('[settings-handlers] APP_VERSION returning:', version);
    return version;
  });

  // ============================================
  // Shell Operations
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
    async (_, url: string): Promise<void> => {
      // Validate URL scheme to prevent opening dangerous protocols
      try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          console.warn(`[SHELL_OPEN_EXTERNAL] Blocked URL with unsafe protocol: ${parsedUrl.protocol}`);
          throw new Error(`Unsafe URL protocol: ${parsedUrl.protocol}`);
        }
        await shell.openExternal(url);
      } catch (error) {
        if (error instanceof TypeError) {
          // Invalid URL format
          console.warn(`[SHELL_OPEN_EXTERNAL] Invalid URL format: ${url}`);
          throw new Error('Invalid URL format');
        }
        throw error;
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_TERMINAL,
    async (_, dirPath: string): Promise<IPCResult<void>> => {
      try {
        // Validate dirPath input
        if (!dirPath || typeof dirPath !== 'string' || dirPath.trim() === '') {
          return {
            success: false,
            error: 'Directory path is required and must be a non-empty string'
          };
        }

        // Resolve to absolute path
        const resolvedPath = path.resolve(dirPath);

        // Verify path exists
        if (!existsSync(resolvedPath)) {
          return {
            success: false,
            error: `Directory does not exist: ${resolvedPath}`
          };
        }

        // Verify it's a directory
        try {
          if (!statSync(resolvedPath).isDirectory()) {
            return {
              success: false,
              error: `Path is not a directory: ${resolvedPath}`
            };
          }
        } catch (_statError) {
          return {
            success: false,
            error: `Cannot access path: ${resolvedPath}`
          };
        }

        // Non-null only while the session's tools run in WSL, which is Windows only
        const wsl = getWslInfo();

        if (isMacOS()) {
          // macOS: an argument array, never a command line, so no path can inject a command
          await openTerminalWindow('open', ['-a', 'Terminal', resolvedPath]);
        } else if (wsl) {
          // Tools run in WSL: a WSL console in that folder
          await openTerminalWindow(getWslExePath(), ['-d', wsl.distro, '--cd', resolvedPath]);
        } else if (isWindows()) {
          // Windows: cmd.exe with an argument array. /K keeps the window open after the cd.
          await openTerminalWindow('cmd.exe', ['/K', 'cd', '/d', resolvedPath]);
        } else {
          // Linux: Try common terminal emulators with argument arrays
          // Note: xterm uses cwd option to avoid shell injection vulnerabilities
          const terminals: Array<{ cmd: string; args: string[]; useCwd?: boolean }> = [
            { cmd: 'gnome-terminal', args: ['--working-directory', resolvedPath] },
            { cmd: 'konsole', args: ['--workdir', resolvedPath] },
            { cmd: 'xfce4-terminal', args: ['--working-directory', resolvedPath] },
            { cmd: 'xterm', args: ['-e', 'bash'], useCwd: true }
          ];

          /**
           * The candidates are tried in order and the walk stops at the first one that opens a
           * window, so the emulators are only ever started one at a time. Each attempt is settled
           * within the grace period, which keeps the whole walk under a second even when every
           * candidate has to be tried, and it is settled for good: an emulator that gives up
           * after that has already been reported as open and is left alone rather than replaced,
           * for the reasons openTerminalWindow gives.
           */
          let opened = false;
          for (const { cmd, args, useCwd } of terminals) {
            try {
              await openTerminalWindow(cmd, args, { cwd: useCwd ? resolvedPath : undefined });
              opened = true;
              break;
            } catch {
              // Not installed, or it started and gave up straight away: try the next emulator
            }
          }

          if (!opened) {
            return {
              success: false,
              error: 'No supported terminal emulator found. Please install gnome-terminal, konsole, xfce4-terminal, or xterm.'
            };
          }
        }

        return { success: true };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return {
          success: false,
          error: `Failed to open terminal: ${errorMsg}`
        };
      }
    }
  );

  // ============================================
  // Spell Check Operations
  // ============================================

  /**
   * Set spell check languages based on app language.
   * Called when renderer's i18n language changes to sync spell checker.
   */
  ipcMain.handle(
    IPC_CHANNELS.SPELLCHECK_SET_LANGUAGES,
    async (_, language: string): Promise<IPCResult<{ success: boolean }>> => {
      try {
        // Validate language parameter
        if (!language || typeof language !== 'string') {
          return {
            success: false,
            error: 'Invalid language parameter'
          };
        }

        // Update tracked app language for context menu labels
        setAppLanguage(language);

        // Get spell check languages for this app language
        const spellCheckLanguages = SPELL_CHECK_LANGUAGE_MAP[language] || [DEFAULT_SPELL_CHECK_LANGUAGE];

        // Get available languages on this system
        const availableLanguages = session.defaultSession.availableSpellCheckerLanguages;

        // Filter to only available languages
        const validLanguages = spellCheckLanguages.filter(lang =>
          availableLanguages.includes(lang)
        );

        // Fallback to default if none of the preferred languages are available
        const languagesToSet = validLanguages.length > 0
          ? validLanguages
          : (availableLanguages.includes(DEFAULT_SPELL_CHECK_LANGUAGE) ? [DEFAULT_SPELL_CHECK_LANGUAGE] : []);

        if (languagesToSet.length > 0) {
          session.defaultSession.setSpellCheckerLanguages(languagesToSet);
          console.log(`[SPELLCHECK] Languages set to: ${languagesToSet.join(', ')} for app language: ${language}`);
        } else {
          console.warn(`[SPELLCHECK] No valid spell check languages available for: ${language}`);
        }

        return {
          success: true,
          data: { success: true }
        };
      } catch (error) {
        console.error('[SPELLCHECK_SET_LANGUAGES] Error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set spell check languages'
        };
      }
    }
  );
}
