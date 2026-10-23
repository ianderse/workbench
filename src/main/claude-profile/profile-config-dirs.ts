/**
 * Every Claude config dir a session of this machine can live under: Claude Code's default dir, the
 * one the environment points at, and each account's own. A session started on one account can end
 * up under another's dir after a swap, so anything looking for a transcript searches all of them.
 */
import path from 'path';
import { getClaudeProfileManager } from '../claude-profile-manager';
import { getDefaultClaudeConfigDir } from './config-dir-paths';
import { appLog } from '../app-logger';
import { expandClaudeHome, isClaudeHomeInWsl } from '../platform/claude-home';

/** Config dirs to search, absolute and without duplicates */
export function claudeConfigDirs(extra: Array<string | undefined> = []): string[] {
  const inWsl = isClaudeHomeInWsl();
  // The app's own CLAUDE_CONFIG_DIR is a Windows setting; Claude Code in WSL doesn't see it
  const dirs = [getDefaultClaudeConfigDir(), inWsl ? undefined : process.env.CLAUDE_CONFIG_DIR, ...extra];
  try {
    dirs.push(...getClaudeProfileManager().getProfileConfigDirs());
  } catch (error) {
    // Profiles are unavailable in some contexts (tests, early startup); the default dir still works
    appLog.warn('[ClaudeProfiles] Could not list the Claude account config dirs:', error);
  }
  const paths = inWsl ? path.win32 : path;
  const expanded = dirs
    .filter((dir): dir is string => !!dir)
    .map((dir) => paths.resolve(expandClaudeHome(dir)));
  return [...new Set(expanded)];
}
