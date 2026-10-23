/**
 * Where Claude Code keeps a config dir's files.
 *
 * Claude Code's own default dir (`~/.claude`, used when CLAUDE_CONFIG_DIR isn't set) keeps its
 * global config in `~/.claude.json` and its macOS keychain entry under the plain
 * "Claude Code-credentials" name. Any other dir (CLAUDE_CONFIG_DIR) keeps `.claude.json` inside
 * itself and gets a keychain entry keyed to the dir. Runs on the default dir must leave
 * CLAUDE_CONFIG_DIR unset, or Claude Code would look in the other places.
 */
import path from 'path';
import { isWindows } from '../platform';
import { expandClaudeHome, isClaudeHomeInWsl, joinClaudeHome } from '../platform/claude-home';

/** Claude Code's default config dir (in WSL the Linux home's, as a UNC path) */
export function getDefaultClaudeConfigDir(): string {
  return joinClaudeHome('.claude');
}

function expand(dir: string): string {
  return expandClaudeHome(dir);
}

/** Path functions for config dirs: Windows ones for the UNC paths of the Linux home in WSL */
function pathApi(): typeof path {
  return isClaudeHomeInWsl() ? path.win32 : path;
}

/** Whether a config dir is Claude Code's default `~/.claude` */
export function isDefaultClaudeConfigDir(dir: string | undefined): boolean {
  if (!dir) return false;
  const normalize = (value: string) => pathApi().resolve(expand(value)).replace(/[\\/]+$/, '');
  const a = normalize(dir);
  const b = normalize(getDefaultClaudeConfigDir());
  return isWindows() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The global config (`.claude.json`: sign-in account, onboarding) of a config dir */
export function getClaudeGlobalConfigPath(configDir: string): string {
  return isDefaultClaudeConfigDir(configDir)
    ? joinClaudeHome('.claude.json')
    : pathApi().join(expand(configDir), '.claude.json');
}

/**
 * Environment for running Claude Code on the config dir an env names: the default dir runs
 * without CLAUDE_CONFIG_DIR (also dropping one the app itself was started with)
 */
export function withClaudeConfigDir<T extends Record<string, string | undefined>>(env: T): T {
  if (env.CLAUDE_CONFIG_DIR && isDefaultClaudeConfigDir(env.CLAUDE_CONFIG_DIR)) {
    const { CLAUDE_CONFIG_DIR: _, ...rest } = env;
    return rest as T;
  }
  return env;
}
