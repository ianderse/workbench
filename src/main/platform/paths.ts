/**
 * Platform-Specific Path Resolvers
 *
 * Handles detection of tool paths across platforms.
 * Each tool has a dedicated resolver function.
 */

import * as path from 'path';
import { isWindows } from './index';

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
