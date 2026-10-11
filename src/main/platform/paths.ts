/**
 * Platform-Specific Path Resolvers
 *
 * Handles detection of tool paths across platforms.
 * Each tool has a dedicated resolver function.
 */

import * as path from 'path';
import * as os from 'os';
import { isWindows, isMacOS, joinPaths } from './index';
import { getWhereExePath } from '../utils/windows-paths';

/**
 * Get all Windows shell paths for terminal selection
 *
 * Returns a map of shell types to their possible installation paths.
 * Only applies to Windows; returns empty object for other platforms.
 */
export function getWindowsShellPaths(): Record<string, string[]> {
  if (!isWindows()) {
    return {};
  }

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';

  // Note: path.join('C:', 'foo') produces 'C:foo' (relative to C: drive), not 'C:\foo'
  // We must use 'C:\\' or raw paths like 'C:\\Program Files' to get absolute paths
  return {
    powershell: [
      path.join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    ],
    windowsterminal: [
      path.join('C:\\Program Files', 'WindowsApps', 'Microsoft.WindowsTerminal_*', 'WindowsTerminal.exe')
    ],
    cmd: [
      path.join(systemRoot, 'System32', 'cmd.exe')
    ],
    gitbash: [
      path.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe')
    ],
    cygwin: [
      path.join('C:\\cygwin64', 'bin', 'bash.exe')
    ],
    msys2: [
      path.join('C:\\msys64', 'usr', 'bin', 'bash.exe')
    ],
    wsl: [
      path.join(systemRoot, 'System32', 'wsl.exe')
    ]
  };
}

/**
 * Resolve Ollama executable paths
 *
 * Returns platform-specific paths where Ollama may be installed:
 * - Windows: LocalAppData, Program Files
 * - macOS: Homebrew paths, /usr/local/bin
 * - Linux: /usr/local/bin, /usr/bin, ~/.local/bin
 */
export function getOllamaExecutablePaths(): string[] {
  const homeDir = os.homedir();
  const paths: string[] = [];

  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || joinPaths(homeDir, 'AppData', 'Local');
    paths.push(
      joinPaths(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      joinPaths(localAppData, 'Ollama', 'ollama.exe'),
      joinPaths('C:\\Program Files', 'Ollama', 'ollama.exe'),
      joinPaths('C:\\Program Files (x86)', 'Ollama', 'ollama.exe')
    );
  } else if (isMacOS()) {
    paths.push(
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      joinPaths(homeDir, '.local', 'bin', 'ollama')
    );
  } else {
    // Linux
    paths.push(
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      joinPaths(homeDir, '.local', 'bin', 'ollama')
    );
  }

  return paths;
}

/**
 * Get the platform-specific install command for Ollama
 *
 * Windows: Uses winget (Windows Package Manager)
 * macOS: Uses Homebrew
 * Linux: Uses official install script
 */
export function getOllamaInstallCommand(): string {
  if (isWindows()) {
    return 'winget install --id Ollama.Ollama --accept-source-agreements';
  } else if (isMacOS()) {
    return 'brew install ollama';
  } else {
    return 'curl -fsSL https://ollama.com/install.sh | sh';
  }
}

/**
 * Get the command to find executables in PATH
 *
 * Windows: Full path to where.exe (C:\Windows\System32\where.exe)
 *          Using full path ensures it works even when System32 isn't in PATH,
 *          which can happen in restricted environments or when Electron doesn't
 *          inherit the full system PATH.
 * Unix: which
 */
export function getWhichCommand(): string {
  return isWindows() ? getWhereExePath() : 'which';
}