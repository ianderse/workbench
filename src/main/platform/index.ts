import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { OS } from './types';
import { getTaskkillExePath } from '../utils/windows-paths';

// Re-export from paths.ts for backward compatibility
export { getWindowsShellPaths, getOllamaExecutablePaths, getOllamaInstallCommand, getWhichCommand } from './paths';

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return process.platform === OS.Windows;
}

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
  return process.platform === OS.macOS;
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
  return process.platform === OS.Linux;
}

/**
 * Check if running on a Unix-like system (macOS or Linux)
 */
export function isUnix(): boolean {
  return !isWindows();
}

/**
 * Get the path separator for environment variables
 */
export function getPathDelimiter(): string {
  return isWindows() ? ';' : ':';
}

/**
 * Get the default file extension for executables
 */
export function getExecutableExtension(): string {
  return isWindows() ? '.exe' : '';
}

/**
 * Check if a command requires shell execution on Windows
 *
 * Windows needs shell execution for .cmd and .bat files
 */
export function requiresShell(command: string): boolean {
  if (!isWindows()) return false;

  const ext = path.extname(command).toLowerCase();
  return ['.cmd', '.bat', '.ps1'].includes(ext);
}

/**
 * Get the npm command name for the current platform
 */
export function getNpmCommand(): string {
  return isWindows() ? 'npm.cmd' : 'npm';
}

/**
 * Join path parts using the platform separator
 */
export function joinPaths(...parts: string[]): string {
  return path.join(...parts);
}

/**
 * Grace period (ms) before force-killing a process after graceful termination.
 * Used for SIGTERM->SIGKILL (Unix) and kill()->taskkill (Windows) patterns.
 */
export const GRACEFUL_KILL_TIMEOUT_MS = 5000;

export interface KillProcessOptions {
  /** Custom timeout in ms (defaults to GRACEFUL_KILL_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Debug logging prefix */
  debugPrefix?: string;
  /** Whether debug logging is enabled */
  debug?: boolean;
}

/**
 * Platform-aware process termination with graceful shutdown and forced fallback.
 *
 * Windows: .kill() then taskkill /f /t as fallback
 * Unix: SIGTERM then SIGKILL as fallback
 *
 * IMPORTANT: Taskkill/SIGKILL runs OUTSIDE the .kill() try-catch to ensure
 * fallback executes even if graceful kill throws.
 */
export function killProcessGracefully(
  childProcess: ChildProcess,
  options: KillProcessOptions = {}
): void {
  const {
    timeoutMs = GRACEFUL_KILL_TIMEOUT_MS,
    debugPrefix = '[ProcessKill]',
    debug = false
  } = options;

  const pid = childProcess.pid;
  const log = (...args: unknown[]) => {
    if (debug) console.warn(debugPrefix, ...args);
  };

  // Track if process exits before force-kill timeout
  let hasExited = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const cleanup = () => {
    hasExited = true;
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  if (typeof childProcess.once === 'function') {
    childProcess.once('exit', cleanup);
    childProcess.once('error', cleanup);  // Also cleanup on error
  } else {
    log('process.once unavailable, cannot track exit state');
  }

  // Attempt graceful termination (may throw if process dead)
  try {
    if (isWindows()) {
      childProcess.kill();  // Windows: no signal argument
    } else {
      childProcess.kill('SIGTERM');
    }
    log('Graceful kill signal sent');
  } catch (err) {
    log('Graceful kill failed (process likely dead):',
      err instanceof Error ? err.message : String(err));
  }

  // ALWAYS schedule force-kill fallback OUTSIDE the try-catch
  // This ensures fallback runs even if .kill() threw
  if (pid) {
    forceKillTimer = setTimeout(() => {
      if (hasExited) {
        log('Process already exited, skipping force kill');
        return;
      }

      try {
        if (isWindows()) {
          log('Running taskkill for PID:', pid);
          spawn(getTaskkillExePath(), ['/pid', pid.toString(), '/f', '/t'], {
            stdio: 'ignore',
            detached: true
          }).unref();
        } else if (!childProcess.killed) {
          log('Sending SIGKILL to PID:', pid);
          childProcess.kill('SIGKILL');
        }
      } catch (err) {
        log('Force kill failed:',
          err instanceof Error ? err.message : String(err));
      }
    }, timeoutMs);

    // Unref timer so it doesn't prevent Node.js from exiting
    forceKillTimer.unref();
  }
}
