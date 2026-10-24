/**
 * Shell Escape Utilities
 *
 * Provides safe escaping for shell command arguments to prevent command injection.
 * IMPORTANT: Always use these utilities when interpolating user-controlled values into shell commands.
 */

import { isWindows } from '../platform';
import type { ShellKind } from '../types/terminal';

// Re-export for convenience
export type { ShellKind };

/**
 * The shell kind to assume when a terminal doesn't say: PowerShell on Windows, POSIX elsewhere
 * (the shells agent windows start by default)
 */
export function defaultShellKind(): ShellKind {
  return isWindows() ? 'powershell' : 'posix';
}

/**
 * Escape a string for safe use as a shell argument.
 *
 * Uses single quotes which prevent all shell expansion (variables, command substitution, etc.)
 * except for single quotes themselves, which are escaped as '\''
 *
 * Examples:
 * - "hello" → 'hello'
 * - "hello world" → 'hello world'
 * - "it's" → 'it'\''s'
 * - "$(rm -rf /)" → '$(rm -rf /)'
 * - 'test"; rm -rf / #' → 'test"; rm -rf / #'
 *
 * @param arg - The argument to escape
 * @returns The escaped argument wrapped in single quotes
 */
export function escapeShellArg(arg: string): string {
  // Replace single quotes with: end quote, escaped quote, start quote
  // This is the standard POSIX-safe way to handle single quotes
  const escaped = arg.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

/**
 * Quote a string as a PowerShell single-quoted literal, for both PowerShell 7 and Windows
 * PowerShell 5.1.
 *
 * Nothing expands inside single quotes (no `$`, backtick or subexpression), so only the quote
 * characters need escaping, by doubling. PowerShell also ends a single-quoted string at the
 * typographic quotes U+2018-U+201B, so those are doubled too. Line breaks are dropped: typed into a
 * terminal they would submit the line early.
 *
 * Examples:
 * - "C:\Program Files" -> 'C:\Program Files'
 * - "it's" -> 'it''s'
 * - '$env:X; rm' -> '$env:X; rm'
 */
export function escapePowerShellArg(arg: string): string {
  const escaped = arg
    .replace(/[\r\n]/g, '')
    .replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote);
  return `'${escaped}'`;
}

/**
 * Escape a path for use in a cd command.
 *
 * @param path - The path to escape
 * @returns The escaped path safe for use in shell commands
 */
function escapeShellPath(path: string): string {
  return escapeShellArg(path);
}

/**
 * Build a safe cd command from a path, in the syntax of the terminal's shell, ending in the
 * separator that chains the next command.
 *
 * - posix: `cd '<path>' && `
 * - cmd: `cd /d "<path>" && ` (/d also changes the drive; escapeForWindowsDoubleQuote inside the quotes)
 * - powershell: `Set-Location -LiteralPath '<path>' -ErrorAction Stop; ` - Windows PowerShell 5.1
 *   has no '&&', and -ErrorAction Stop makes a failed cd end the whole typed line, like '&&' would,
 *   so nothing chained after it runs in the wrong directory. -LiteralPath keeps '[' and ']' in
 *   folder names from being read as wildcards.
 *
 * @param path - The directory path
 * @param shellKind - The terminal's shell kind (defaults to defaultShellKind())
 * @returns The cd command with its separator, or an empty string if path is undefined
 */
export function buildCdCommand(path: string | undefined, shellKind: ShellKind = defaultShellKind()): string {
  if (!path) {
    return '';
  }

  if (shellKind === 'powershell') {
    return `Set-Location -LiteralPath ${escapePowerShellArg(path)} -ErrorAction Stop; `;
  }

  if (shellKind === 'cmd') {
    // For values inside double quotes, use escapeForWindowsDoubleQuote() because
    // caret is literal inside double quotes in cmd.exe (only double quotes need escaping).
    return `cd /d "${escapeForWindowsDoubleQuote(path)}" && `;
  }

  return `cd ${escapeShellPath(path)} && `;
}

/**
 * Build the prefix that runs what follows with an environment variable removed, in the syntax of
 * the terminal's shell, ending in the separator that chains the command after it.
 *
 * Unsetting is not the same as setting a variable to an empty string or to a default value: a
 * tool that behaves one way when a variable is absent and another when it holds anything at all
 * (Claude Code reads its sign-in from `~/.claude.json` only while CLAUDE_CONFIG_DIR is unset) has
 * to see it absent.
 *
 * - posix: `env -u NAME ` - removed for the command alone, the window's own environment untouched
 * - cmd: `set "NAME=" && ` - cmd.exe runs no command in an environment of its own, and an empty
 *   value is how it deletes a variable; the deletion stays in the window's shell, as the `set` of
 *   a value would
 * - powershell: `Remove-Item Env:\NAME -ErrorAction SilentlyContinue; ` - `$env:NAME = $null`
 *   deletes the variable in PowerShell 7 but leaves it behind holding an empty string in Windows
 *   PowerShell 5.1, which agent windows fall back to, so the variable is removed through the Env:
 *   provider instead. SilentlyContinue is for the variable that was never set: its removal must
 *   not end the typed line (there is no '&&' in 5.1, so the statements after it would run anyway,
 *   but the error would still be on screen).
 *
 * The names passed here are literals in the app's own code, so nothing escapes them.
 *
 * @param name - The environment variable to remove
 * @param shellKind - The terminal's shell kind (defaults to defaultShellKind())
 * @returns The prefix with its separator
 */
export function buildUnsetEnvPrefix(name: string, shellKind: ShellKind = defaultShellKind()): string {
  if (shellKind === 'powershell') {
    return `Remove-Item Env:\\${name} -ErrorAction SilentlyContinue; `;
  }

  if (shellKind === 'cmd') {
    // The '&&' is safe even though the variable is usually not set to begin with, which is the case
    // this prefix exists for: deleting a variable that does not exist succeeds. The rule that SET
    // reports errorlevel 1 for a name it cannot find (ss64, Rob van der Woude) is about `SET NAME`
    // with no equal sign, the form that prints a variable; `SET "NAME="` is a successful deletion
    // either way. Wine's cmd.exe conformance suite pins both halves against real Windows
    // (programs/cmd/tests/test_builtins.cmd, "success/failure for SET command"): two `set
    // "SAVED_PATH="` in a row, the second on a variable already gone, are both expected to be
    // SUCCESS 0, while `set ThisVariableLikelyDoesntExist` is expected to be FAILURE 1.
    return `set "${name}=" && `;
  }

  return `env -u ${name} `;
}

/**
 * Escape a string for safe use inside Windows cmd.exe double-quoted strings.
 *
 * Inside double quotes in cmd.exe, the escaping rules are different:
 * - Caret (^) is a LITERAL character, not an escape character
 * - Only double quotes need escaping, done by doubling them ("")
 * - Percent signs (%) must be escaped as %% to prevent variable expansion
 * - Newlines/carriage returns still need removal (command terminators)
 *
 * Use this for values in set commands like: set "VAR=value"
 *
 * Examples:
 * - "hello" → "hello"
 * - "it's" → "it's"
 * - 'path with "quotes"' → 'path with ""quotes""'
 * - "C:\Company & Co" → "C:\Company & Co" (ampersand protected by quotes)
 * - "%PATH%" → "%%PATH%%" (percent escaped)
 *
 * @param arg - The argument to escape
 * @returns The escaped argument (caller should wrap in double quotes)
 */
export function escapeForWindowsDoubleQuote(arg: string): string {
  // Inside double quotes, only escape embedded double quotes by doubling them.
  // Also escape percent signs to prevent variable expansion.
  // Also remove newlines/carriage returns as they terminate commands.
  const escaped = arg
    .replace(/\r/g, '')        // Remove carriage returns (command terminators)
    .replace(/\n/g, '')        // Remove newlines (command terminators)
    .replace(/%/g, '%%')       // Escape percent (variable expansion in cmd.exe)
    .replace(/"/g, '""');      // Escape double quotes by doubling

  return escaped;
}