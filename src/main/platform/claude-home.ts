/**
 * Where Claude Code keeps its files
 * =================================
 *
 * The home dir Claude Code resolves `~` against (its default config dir is `~/.claude`), the
 * folder names it gives projects under `<config dir>/projects`, and its system-wide managed
 * settings file. Natively Claude Code runs on this OS with this user's home. When the app runs its
 * tools in WSL (shell-runtime.ts), Claude Code runs inside the distribution and keeps its config
 * and credentials in the Linux home, which Windows reaches as `\\wsl.localhost\<distro>\home\<user>`;
 * these functions then answer with those host (UNC) paths.
 *
 * Not re-exported from platform/index.ts, so tests that mock '../platform' wholesale keep working.
 */

import { homedir } from 'os';
import path from 'path';
import { isMacOS, isWindows } from './index';
import { getWslInfo, toRuntimePath } from './shell-runtime';
import { wslToWindows } from './wsl-paths';

/** The home dir Claude Code runs with (a host path: the Linux home's UNC path in WSL) */
export function getClaudeHome(): string {
  const wsl = getWslInfo();
  return wsl?.home ? wslToWindows(wsl.home, wsl) : homedir();
}

/** Whether Claude Code's home is the Linux home of a WSL distribution (the app runs its tools in WSL) */
export function isClaudeHomeInWsl(): boolean {
  return !!getWslInfo()?.home;
}

/**
 * Join path parts onto Claude Code's home. In WSL the home is a Windows UNC path, joined with
 * Windows separators.
 */
export function joinClaudeHome(...parts: string[]): string {
  return (isClaudeHomeInWsl() ? path.win32 : path).join(getClaudeHome(), ...parts);
}

/** A path with a leading `~` resolved against Claude Code's home (other paths unchanged) */
export function expandClaudeHome(p: string): string;
export function expandClaudeHome(p: string | undefined): string | undefined;
export function expandClaudeHome(p: string | undefined): string | undefined {
  if (!p?.startsWith('~')) return p;
  if (isClaudeHomeInWsl()) {
    const rest = p.slice(1).replace(/^[\\/]+/, '');
    return rest ? path.win32.join(getClaudeHome(), rest) : getClaudeHome();
  }
  return p.replace(/^~/, getClaudeHome());
}

/**
 * Folder name Claude Code uses for a project under `<config dir>/projects`: the project's path (as
 * the OS Claude Code runs on sees it) with every character that is not a letter or a digit replaced
 * by a dash. Separators, dots, spaces, underscores and the colon of a Windows drive letter all go
 * the same way, so `/home/me/.config/fish` becomes `-home-me--config-fish` and `C:\Users\me\my app`
 * becomes `C--Users-me-my-app`. A narrower rule would build names that exist nowhere on disk, which
 * reads as the project simply having no sessions.
 *
 * In WSL Claude Code runs inside the distribution and names the folder after the Linux path it sees
 * there, so a host path is translated first; a path that already is a Linux one is left as it is.
 */
export function claudeProjectSlug(projectPath: string): string {
  const asClaudeCodeSeesIt = isClaudeHomeInWsl() ? toRuntimePath(projectPath) : projectPath;
  return asClaudeCodeSeesIt.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Claude Code's managed (system-wide) settings file:
 * - macOS:   /Library/Application Support/ClaudeCode/managed-settings.json
 * - Linux:   /etc/claude-code/managed-settings.json
 * - Windows: C:\Program Files\ClaudeCode\managed-settings.json
 * - WSL:     the distribution's /etc/claude-code/managed-settings.json (as a UNC path)
 */
export function getClaudeManagedSettingsPath(): string {
  const wsl = getWslInfo();
  if (wsl) return wslToWindows('/etc/claude-code/managed-settings.json', wsl);
  if (isWindows()) {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    return path.join(programFiles, 'ClaudeCode', 'managed-settings.json');
  }
  if (isMacOS()) return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}
