/**
 * Where Claude Code keeps a config dir's files.
 *
 * Claude Code's own default dir (`~/.claude`, used when CLAUDE_CONFIG_DIR isn't set) keeps its
 * global config in `~/.claude.json` and its macOS keychain entry under the plain
 * "Claude Code-credentials" name. Any other dir (CLAUDE_CONFIG_DIR) keeps `.claude.json` inside
 * itself and gets a keychain entry keyed to the dir. Runs on the default dir must leave
 * CLAUDE_CONFIG_DIR unset, or Claude Code would look in the other places.
 */
import { homedir } from 'os';
import path from 'path';
import { isWindows } from '../platform';

/** Claude Code's default config dir */
export function getDefaultClaudeConfigDir(): string {
  return path.join(homedir(), '.claude');
}

function expand(dir: string): string {
  return dir.startsWith('~') ? path.join(homedir(), dir.slice(1)) : dir;
}

/** Whether a config dir is Claude Code's default `~/.claude` */
export function isDefaultClaudeConfigDir(dir: string | undefined): boolean {
  if (!dir) return false;
  const normalize = (value: string) => path.resolve(expand(value)).replace(/[\\/]+$/, '');
  const a = normalize(dir);
  const b = normalize(getDefaultClaudeConfigDir());
  return isWindows() ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The global config (`.claude.json`: sign-in account, onboarding) of a config dir */
export function getClaudeGlobalConfigPath(configDir: string): string {
  return isDefaultClaudeConfigDir(configDir)
    ? path.join(homedir(), '.claude.json')
    : path.join(expand(configDir), '.claude.json');
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
