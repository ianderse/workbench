/**
 * Environment for Claude Code CLI runs
 * ====================================
 *
 * Every task, triage and utility call runs the locally installed `claude` CLI. Credentials
 * come from the chosen Claude profile's CLAUDE_CONFIG_DIR (the CLI refreshes OAuth tokens
 * itself), or from the active API profile (Anthropic-compatible endpoint) when one is set.
 */

import path from 'path';
import { existsSync } from 'fs';
import { getClaudeCliInvocationAsync } from '../cli-utils';
import { getToolInfo } from '../cli-tool-manager';
import { getBestAvailableProfileEnv, getProfileEnv } from '../rate-limit-detector';
import { getAPIProfileEnv } from '../services/profile';
import { isWindows } from '../platform';

/** Variables that would make Claude Code use an API key instead of the profile's sign-in */
const API_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const;

export interface ClaudeEnvResult {
  /** Path or command for the `claude` executable */
  command: string;
  env: Record<string, string>;
  /** Claude profile the run uses (undefined for API profiles) */
  profileId?: string;
  profileName?: string;
}

export interface ClaudeEnvOptions {
  /** Use this Claude profile instead of picking the best available one */
  profileId?: string;
  /** Extra variables (applied before credentials, so they cannot override auth) */
  extraEnv?: Record<string, string>;
}

/** Git Bash path that Claude Code needs on Windows, derived from git.exe */
function deriveGitBashPath(gitExePath: string): string | null {
  const gitDir = path.dirname(gitExePath);
  const dirName = path.basename(gitDir).toLowerCase();
  let gitRoot = path.dirname(gitDir);
  if (dirName === 'bin') {
    const parentName = path.basename(gitRoot).toLowerCase();
    if (parentName === 'mingw64' || parentName === 'mingw32') gitRoot = path.dirname(gitRoot);
  }
  const bashPath = path.join(gitRoot, 'bin', 'bash.exe');
  return existsSync(bashPath) ? bashPath : null;
}

/**
 * Resolve the `claude` command and the environment to run it with.
 * Picks the best available Claude profile (rate-limit aware) unless one is given.
 */
export async function resolveClaudeEnv(options: ClaudeEnvOptions = {}): Promise<ClaudeEnvResult> {
  const { command, env: baseEnv } = await getClaudeCliInvocationAsync();
  const env: Record<string, string> = { ...baseEnv, ...(options.extraEnv ?? {}) };

  if (isWindows() && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitInfo = getToolInfo('git');
    const bashPath = gitInfo.found && gitInfo.path ? deriveGitBashPath(gitInfo.path) : null;
    if (bashPath) env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
  }

  // An active API profile (custom Anthropic-compatible endpoint) wins over subscription sign-ins
  const apiProfileEnv = await getAPIProfileEnv();
  if (Object.keys(apiProfileEnv).length > 0) {
    for (const name of API_AUTH_VARS) delete env[name];
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return { command, env: { ...env, ...apiProfileEnv } };
  }

  let profileEnv: Record<string, string>;
  let profileId: string | undefined;
  let profileName: string | undefined;
  if (options.profileId) {
    profileEnv = getProfileEnv(options.profileId);
    profileId = options.profileId;
  } else {
    const best = getBestAvailableProfileEnv();
    profileEnv = best.env;
    profileId = best.profileId;
    profileName = best.profileName;
  }

  // Subscription sign-in: never let a shell API key take over billing
  for (const name of API_AUTH_VARS) delete env[name];
  const merged = { ...env, ...profileEnv };
  if (profileEnv.CLAUDE_CONFIG_DIR) {
    // The CLI reads (and refreshes) tokens from the config dir itself
    delete merged.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return { command, env: merged, profileId, profileName };
}
