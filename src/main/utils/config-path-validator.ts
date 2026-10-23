/**
 * Config Path Validator
 *
 * Security utility to validate Claude profile config directory paths.
 * Prevents path traversal attacks where malicious code could specify
 * arbitrary paths like /etc or C:\Windows\System32\config.
 */

import path from 'path';
import os from 'os';
import { expandClaudeHome, getClaudeHome, isClaudeHomeInWsl } from '../platform/claude-home';

/** Whether a normalized path is a prefix itself or below it (separator boundary) */
function isWithin(normalizedPath: string, prefix: string, paths: typeof path): boolean {
  const resolvedPrefix = paths.resolve(prefix);
  return normalizedPath === resolvedPrefix || normalizedPath.startsWith(resolvedPrefix + paths.sep);
}

/**
 * Validate that a config directory path is safe and within expected boundaries.
 * This prevents path traversal attacks where a malicious renderer could
 * specify arbitrary paths like /etc or C:\Windows\System32\config.
 *
 * When the app runs its tools in WSL, Claude Code's home is the distribution's Linux home
 * (`\\wsl.localhost\<distro>\home\<user>`); paths within it are valid as well.
 *
 * @param configDir - The config directory path to validate (may contain ~)
 * @returns true if the path is safe, false otherwise
 */
export function isValidConfigDir(configDir: string): boolean {
  const homeDir = os.homedir();

  // Allow paths within:
  // 1. User's home directory (~/)
  // 2. ~/.claude (default config directory)
  // 3. ~/.claude-profiles/* (profile config directories)
  // 4. Claude Code's home in WSL (the Linux home's UNC path)
  const allowedPrefixes = [
    homeDir,
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.claude-profiles'),
  ];

  // IMPORTANT: Use path separator boundary to prevent attacks like
  // /home/alice-malicious passing validation for /home/alice
  if (isClaudeHomeInWsl()) {
    // `~` means the Linux home; UNC paths are Windows paths
    // \\wsl$\ is the older name of \\wsl.localhost\
    const normalizedPath = path.win32
      .resolve(expandClaudeHome(configDir))
      .replace(/^\\\\wsl\$\\/i, '\\\\wsl.localhost\\');
    if (isWithin(normalizedPath, getClaudeHome(), path.win32)) return true;
    if (!configDir.startsWith('~') && allowedPrefixes.some((prefix) => isWithin(normalizedPath, prefix, path.win32))) {
      return true;
    }
    console.warn('[Config Path Validator] Rejected unsafe configDir path:', configDir, '(normalized:', normalizedPath, ')');
    return false;
  }

  // Expand ~ to home directory for validation
  const expandedPath = configDir.startsWith('~')
    ? path.join(homeDir, configDir.slice(1))
    : configDir;

  // Normalize to resolve any .. or . components
  const normalizedPath = path.resolve(expandedPath);

  // Check if normalized path starts with any allowed prefix
  for (const prefix of allowedPrefixes) {
    if (isWithin(normalizedPath, prefix, path)) {
      return true;
    }
  }

  console.warn('[Config Path Validator] Rejected unsafe configDir path:', configDir, '(normalized:', normalizedPath, ')');
  return false;
}
