/**
 * Startup checks for the shell runtime's git (Windows)
 * ====================================================
 *
 * The app remembers which runtime it ran its tools in last time (native Windows or WSL) and the
 * git version each runtime had, in `<userData>/shell-runtime-state.json`. At startup, in the
 * background:
 * - the git versions decide whether new worktrees may use relative links (runtime-worktrees.ts)
 * - when the runtime differs from last time, every project's worktrees are repaired for this
 *   runtime's git (`git worktree repair`), one project after the other
 * - in WSL, Windows git and WSL git are compared for core.autocrlf, which makes one of them see
 *   every file as changed when they differ
 *
 * Nothing here blocks the main process.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';
import { appLog } from '../app-logger';
import { getToolInfoAsync } from '../cli-tool-manager';
import { isWindows } from '../platform';
import { getWslInfo, isWslRuntime, setAutocrlfMismatch, whenShellRuntimeReady } from '../platform/shell-runtime';
import { runTool } from '../platform/runtime-exec';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import {
  findWindowsExecutableViaWhereAsync,
  getWindowsExecutablePathsAsync,
  WINDOWS_GIT_PATHS,
} from '../utils/windows-paths';
import {
  repairProjectWorktrees,
  setKnownGitVersions,
  setWslPathHints,
  useRelativeWorktreePaths,
  type RuntimeGitVersions,
  type WslPathHints,
} from './runtime-worktrees';

const execFileAsync = promisify(execFile);

const STATE_FILE = 'shell-runtime-state.json';
const NATIVE_GIT_TIMEOUT_MS = 10_000;

export type ToolRuntime = 'native' | 'wsl';

export interface StoredRuntimeState {
  runtime: ToolRuntime;
  gitVersions: RuntimeGitVersions;
  wsl?: WslPathHints;
}

function statePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

export async function readRuntimeState(file = statePath()): Promise<StoredRuntimeState | null> {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<StoredRuntimeState>;
    if (data.runtime !== 'native' && data.runtime !== 'wsl') return null;
    return { runtime: data.runtime, gitVersions: data.gitVersions ?? {}, ...(data.wsl ? { wsl: data.wsl } : {}) };
  } catch {
    return null;
  }
}

async function writeRuntimeState(state: StoredRuntimeState, file = statePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Windows git while the app runs its tools in WSL (the tool manager then only knows WSL's):
 * the Paths setting, `where git`, or the usual install folders
 */
export async function findNativeGit(): Promise<string | null> {
  const configured = readSettingsFile()?.gitPath;
  if (typeof configured === 'string' && /^[A-Za-z]:[\\/]/.test(configured) && existsSync(configured)) return configured;
  const found = await findWindowsExecutableViaWhereAsync('git', '[RuntimeSwitch]');
  if (found) return found;
  return (await getWindowsExecutablePathsAsync(WINDOWS_GIT_PATHS, '[RuntimeSwitch]'))[0] ?? null;
}

/** Run Windows git directly: in WSL mode the runtime layer would run WSL's */
async function runNativeGit(gitPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(gitPath, args, {
    cwd: os.homedir(),
    encoding: 'utf-8',
    timeout: NATIVE_GIT_TIMEOUT_MS,
    windowsHide: true,
    shell: /\.(cmd|bat)$/i.test(gitPath),
  });
  return stdout.trim();
}

/** core.autocrlf as git reports it outside a repository (system and global), 'unset' when not set */
async function readAutocrlf(read: () => Promise<string>): Promise<string> {
  try {
    return (await read()).toLowerCase() || 'unset';
  } catch {
    // `git config --get` exits with 1 when the key isn't set
    return 'unset';
  }
}

/** Whether two core.autocrlf values convert line endings the same way (unset = false) */
export function autocrlfDiffers(windows: string, wsl: string): boolean {
  const normalize = (value: string) => (value === 'unset' ? 'false' : value);
  return normalize(windows) !== normalize(wsl);
}

/** Compare core.autocrlf of Windows git and WSL git; a difference is logged and shown in the status */
export async function checkLineEndings(nativeGit: string | null): Promise<void> {
  const wsl = getWslInfo();
  if (!wsl || !nativeGit) return;
  const [windows, linux] = await Promise.all([
    readAutocrlf(() => runNativeGit(nativeGit, ['config', '--get', 'core.autocrlf'])),
    readAutocrlf(async () => (await runTool('git', ['-C', wsl.home, 'config', '--get', 'core.autocrlf'], { timeout: NATIVE_GIT_TIMEOUT_MS })).stdout.trim()),
  ]);
  if (autocrlfDiffers(windows, linux)) {
    setAutocrlfMismatch({ windows, wsl: linux });
    appLog.warn(
      `[RuntimeSwitch] core.autocrlf differs between Windows git (${windows}) and WSL git (${linux}): ` +
      'a checkout used by both can show every file as changed in one of them. Set the same value in both ' +
      '(for example `git config --global core.autocrlf input` in WSL and on Windows)'
    );
  } else {
    setAutocrlfMismatch(null);
  }
}

/** Repair every project's worktrees for this runtime's git, one project at a time */
export async function repairAllProjects(projectPaths: string[]): Promise<void> {
  for (const projectPath of projectPaths) {
    if (!existsSync(path.join(projectPath, '.git'))) continue;
    const result = await repairProjectWorktrees(projectPath, { all: true });
    if (result.error) {
      appLog.warn(`[RuntimeSwitch] Repairing the worktrees of ${projectPath} failed: ${result.error}`);
    } else if (result.repaired.length > 0) {
      appLog.info(`[RuntimeSwitch] Repaired ${result.repaired.length} worktree(s) of ${projectPath}`);
    }
  }
}

/**
 * The startup check (Windows only, in the background): record this runtime and its git version,
 * repair worktrees when the runtime changed since the last start, compare line endings in WSL.
 * Never throws.
 */
export async function checkRuntimeAtStartup(
  options: { stateFile?: string; projectPaths?: () => string[] } = {}
): Promise<void> {
  if (!isWindows()) return;
  try {
    await whenShellRuntimeReady();
    const runtime: ToolRuntime = isWslRuntime() ? 'wsl' : 'native';
    const stored = await readRuntimeState(options.stateFile);
    const wsl = getWslInfo();

    let nativeGit: string | null = null;
    let nativeVersion: string | null | undefined;
    if (runtime === 'wsl') {
      nativeGit = await findNativeGit();
      nativeVersion = nativeGit
        ? await runNativeGit(nativeGit, ['--version']).then((out) => out.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null, () => null)
        : null;
    } else {
      const info = await getToolInfoAsync('git');
      nativeVersion = info.found ? info.version ?? null : null;
    }

    const gitVersions: RuntimeGitVersions = {
      native: nativeVersion,
      wsl: wsl ? (wsl.tools.git.path ? wsl.tools.git.version : null) : stored?.gitVersions.wsl,
    };
    const hints = wsl ? { distro: wsl.distro, mountRoot: wsl.mountRoot } : stored?.wsl;
    setKnownGitVersions(gitVersions);
    setWslPathHints(hints);

    const relative = await useRelativeWorktreePaths();
    appLog.info(
      `[RuntimeSwitch] Tools run ${runtime === 'wsl' ? `in WSL (${wsl?.distro})` : 'natively'}; git ` +
      `${gitVersions.native ?? 'none'} (Windows), ${gitVersions.wsl ?? (gitVersions.wsl === null ? 'none' : 'unknown')} (WSL); ` +
      `new worktrees use ${relative ? 'relative' : 'absolute'} links`
    );

    // The first start that records a runtime follows native sessions
    const previous: ToolRuntime = stored?.runtime ?? 'native';
    if (previous !== runtime) {
      const projectPaths = options.projectPaths?.() ?? projectStore.getProjects().map((project) => project.path);
      appLog.info(`[RuntimeSwitch] Runtime changed (${previous} -> ${runtime}): repairing the worktrees of ${projectPaths.length} project(s)`);
      await repairAllProjects(projectPaths);
    } else {
      appLog.info(`[RuntimeSwitch] Same runtime as the last start (${runtime}): worktrees need no repair`);
    }
    // Recorded after the repair, so a repair cut short by quitting runs again next time
    await writeRuntimeState({ runtime, gitVersions, ...(hints ? { wsl: hints } : {}) }, options.stateFile);

    if (runtime === 'wsl') await checkLineEndings(nativeGit);
  } catch (error) {
    appLog.warn('[RuntimeSwitch] Startup check failed:', error);
  }
}
