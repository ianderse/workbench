/**
 * Application Logger Service
 *
 * Provides persistent, always-on logging for the main process using electron-log.
 * Logs are stored in the standard OS log directory:
 * - macOS: ~/Library/Logs/Auto-Claude/
 * - Windows: %USERPROFILE%\AppData\Roaming\Auto-Claude\logs\
 * - Linux: ~/.config/Auto-Claude/logs/
 *
 * Features:
 * - Automatic file rotation (7 days, max 10MB per file)
 * - Always-on logging (not dependent on DEBUG flag)
 * - Debug info collection for support/bug reports
 * - Beta version detection for enhanced logging
 */

import log from 'electron-log/main.js';
import { app } from 'electron';
import { formatDateTime, formatTime } from '../shared/utils/format-date-time';

// Configure electron-log (wrapped in try-catch for re-import scenarios in tests)
try {
  log.initialize();
} catch {
  // Already initialized, ignore
}

// File transport configuration
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB max file size
// Local time like the UI ("10/10/2026, 1:35:21 AM"); the text keeps electron-log's own formatting
log.transports.file.format = ({ data, level, message }) => [`[${formatDateTime(message.date)}] [${level}]`, ...data];
log.transports.file.fileName = 'main.log';

// Note: We use electron-log's default archiveLogFn which properly rotates logs
// by renaming old files to .old format. Custom implementations were problematic.

// Console transport - always show warnings and errors, debug only in dev mode
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn';
log.transports.console.format = ({ data, level, message }) => [`[${formatTime(message.date)}] [${level}]`, ...data];
// Guard console transport writes so broken stdio streams do not crash the app.
{
  const originalConsoleWriteFn = log.transports.console.writeFn as (...args: unknown[]) => void;
  log.transports.console.writeFn = (...args: unknown[]) => {
    try {
      originalConsoleWriteFn(...args);
    } catch (error) {
      const err = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      safeStderrWrite(`[app-logger] console transport write failed: ${err}`);
    }
  };
}

// Determine if this is a beta version
function isBetaVersion(): boolean {
  try {
    const version = app.getVersion();
    return version.includes('-beta') || version.includes('-alpha') || version.includes('-rc');
  } catch (error) {
    log.warn('Failed to detect beta version:', error);
    return false;
  }
}

// Enhanced logging for beta versions
if (isBetaVersion()) {
  log.transports.file.level = 'debug';
  log.info('Beta version detected - enhanced logging enabled');
} else {
  log.transports.file.level = 'info';
}

// Export convenience methods that match console API
export const appLog = {
  debug: (...args: unknown[]) => log.debug(...args),
  info: (...args: unknown[]) => log.info(...args),
  warn: (...args: unknown[]) => log.warn(...args),
  error: (...args: unknown[]) => log.error(...args),
  log: (...args: unknown[]) => log.info(...args),
};

/**
 * Best-effort stderr fallback used when electron-log itself throws (e.g. EIO).
 * Must never throw, especially inside uncaught exception handlers.
 */
function safeStderrWrite(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Ignore - nothing else we can safely do here.
  }
}

/**
 * Log an unhandled error without risking recursive crashes if logger transport fails.
 */
function safeLogUnhandled(prefix: string, value: unknown): void {
  try {
    log.error(prefix, value);
  } catch (loggingError) {
    const loggingFailure = loggingError instanceof Error
      ? `${loggingError.name}: ${loggingError.message}`
      : String(loggingError);
    const original = value instanceof Error
      ? (value.stack || `${value.name}: ${value.message}`)
      : String(value);
    safeStderrWrite(`[app-logger] ${prefix} (logger failed: ${loggingFailure})`);
    safeStderrWrite(original);
  }
}

// Log unhandled errors
export function setupErrorLogging(): void {
  process.on('uncaughtException', (error) => {
    safeLogUnhandled('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason) => {
    safeLogUnhandled('Unhandled rejection:', reason);
  });

  log.info('Error logging initialized');
}
