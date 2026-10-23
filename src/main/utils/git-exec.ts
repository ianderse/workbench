/**
 * Running git
 * ===========
 *
 * `git(args, { cwd })` runs the detected git through the runtime layer (platform/runtime-exec),
 * with the promisified execFile contract: resolves with { stdout, stderr }, rejects with an
 * error carrying code/stdout/stderr. Use it for every git call instead of spawning git directly.
 */

import { runTool, type RunToolResult } from '../platform/runtime-exec';
import { getIsolatedGitEnv } from './git-isolation';

export interface GitOptions {
  cwd: string;
  /** Environment for git (defaults to the app's own) */
  env?: NodeJS.ProcessEnv;
  /**
   * Clear the git variables that leak between worktrees (GIT_DIR, GIT_WORK_TREE, ...) and set
   * HUSKY=0, starting from `env` (or the app's environment): getIsolatedGitEnv()
   */
  isolated?: boolean;
  timeout?: number;
  maxBuffer?: number;
  encoding?: BufferEncoding;
  signal?: AbortSignal;
}

/** Run a git command and collect its output */
export function git(args: string[], options: GitOptions): Promise<RunToolResult> {
  const { isolated, env, ...runOptions } = options;
  return runTool('git', args, { ...runOptions, env: isolated ? getIsolatedGitEnv(env ?? process.env) : env });
}
