/**
 * Agent windows in WSL
 * ====================
 *
 * When the app runs its tools in WSL (shell-runtime.ts), agent windows and terminals run inside the
 * distribution too. node-pty starts
 *
 *   wsl.exe -d <distro> --cd <cwd inside WSL>
 *
 * which opens the user's login shell (the passwd entry) as an interactive login shell, so their rc
 * files, prompt and PATH are there as in any WSL terminal. The Windows side runs in the Windows
 * home (no Windows cwd is needed: `--cd` picks the Linux one).
 *
 * The environment reaches Linux through WSLENV, as for every tool the app runs in WSL
 * (runtime-exec's buildWslEnv): only what the app adds for the window (CLAUDE_CONFIG_DIR and
 * GRAPHIFY_OUT translated to Linux paths, WORKBENCH_TERMINAL_ID, TERM, COLORTERM, the profile's
 * and Claude Code settings' variables), never PATH or Windows-only variables.
 *
 * The app types POSIX commands (shellKind 'posix') into the window. Login shells that don't take
 * POSIX syntax get them another way:
 * - fish: every line the app types runs through `bash -c '<line>'`, quoted the way fish reads
 *   single quotes, so the line is bash syntax whatever fish version the distribution has
 * - any other non-POSIX shell (nushell, xonsh, csh...): the window starts bash instead
 *
 * Not re-exported anywhere; nothing here runs outside WSL mode.
 */

import { buildWslEnv } from '../platform/runtime-exec';
import { toRuntimePath } from '../platform/shell-runtime';
import { getWslExePath, type WslProbeResult } from '../platform/wsl-detect';

/** Login shells that take the POSIX syntax the app types */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'pdksh', 'ash', 'yash', 'busybox']);

/** How a login shell gets the commands the app types */
export type WslShellHandling = 'posix' | 'fish' | 'other';

/** Classify a login shell by its program name (`/usr/bin/fish` -> 'fish') */
export function classifyWslLoginShell(loginShell: string | undefined): WslShellHandling {
  const name = (loginShell ?? '').split('/').pop()?.trim().toLowerCase() ?? '';
  if (!name || POSIX_SHELLS.has(name)) return 'posix';
  if (name === 'fish') return 'fish';
  return 'other';
}

/**
 * Quote text as one fish argument: in fish single quotes only `\\` and `\'` are escapes, so both
 * characters are escaped and everything else (`$`, `"`, backticks, `;`, line breaks) stays literal.
 */
export function quoteForFish(text: string): string {
  return `'${text.replace(/[\\']/g, (char) => `\\${char}`)}'`;
}

/**
 * A line typed into a fish window: the POSIX line run by bash. The leading space keeps the line out
 * of fish's history (and so the config dir and token file paths it names).
 */
export function wrapLineForFish(line: string): string {
  return ` bash -c ${quoteForFish(line)}`;
}

/** Variables the window always gets inside WSL, even when the app's own environment has the same value */
const ALWAYS_FORWARD = ['TERM', 'COLORTERM'];

/**
 * The environment wsl.exe runs with for an agent window: the window's environment with what the
 * app added listed in WSLENV (path values translated), see buildWslEnv. The login shell sets
 * its own PATH, so the PATH the tool wrapper uses (WB_PATH) is left out.
 */
export function buildWslPtyEnv(env: Record<string, string | undefined>, info: WslProbeResult): Record<string, string> {
  const result = buildWslEnv(env, info.loginPath);
  delete result.WB_PATH;
  const listed = (result.WSLENV ?? '').split(':').filter((entry) => entry && entry.split('/')[0] !== 'WB_PATH');
  const names = new Set(listed.map((entry) => entry.split('/')[0].toUpperCase()));
  for (const key of ALWAYS_FORWARD) {
    if (result[key] !== undefined && !names.has(key)) listed.push(key);
  }
  result.WSLENV = listed.join(':');

  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(result)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

export interface WslPtyLaunch {
  /** wsl.exe */
  file: string;
  args: string[];
  /** Working directory of wsl.exe on the Windows side */
  cwd: string;
  env: Record<string, string>;
  /** The login shell is fish: the lines the app types run through `bash -c` */
  wrapInBash: boolean;
}

/**
 * How node-pty starts an agent window in WSL: the login shell (bash for login shells that take
 * neither POSIX nor fish syntax) in the window's directory inside WSL, the Linux home when the
 * window has none
 */
export function buildWslPtyLaunch(
  cwd: string | undefined,
  env: Record<string, string | undefined>,
  info: WslProbeResult,
  windowsHome: string
): WslPtyLaunch {
  const handling = classifyWslLoginShell(info.loginShell);
  const args = ['-d', info.distro, '--cd', cwd ? toRuntimePath(cwd) : '~'];
  if (handling === 'other') args.push('--exec', '/bin/bash', '-l');
  return {
    file: getWslExePath(),
    args,
    cwd: windowsHome,
    env: buildWslPtyEnv(env, info),
    wrapInBash: handling === 'fish',
  };
}
