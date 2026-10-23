/**
 * Minimal command runner inside WSL for tool checks (Settings > Developer > Paths): runs one
 * program with arguments in the distribution the app uses, with the login PATH from the startup
 * probe, without a shell (so a path can't inject commands). Async only.
 *
 * Not re-exported from platform/index.ts.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getWslInfo } from './shell-runtime';
import { decodeWslOutput, getWslExePath, type WslProbeResult } from './wsl-detect';

const execFileAsync = promisify(execFile);

export interface WslCommandOptions {
  /** Defaults to 15 seconds */
  timeout?: number;
  /** Distribution and login PATH; defaults to the probe of this session */
  info?: Pick<WslProbeResult, 'distro' | 'loginPath'>;
}

/**
 * Run `file args...` inside WSL and return its output. Throws when the app doesn't run its tools
 * in WSL, or when the program fails, times out or doesn't exist.
 */
export async function execInWsl(
  file: string,
  args: string[],
  options: WslCommandOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const info = options.info ?? getWslInfo();
  if (!info) throw new Error('The app does not run its tools in WSL');

  const result = await execFileAsync(
    getWslExePath(),
    ['-d', info.distro, '--exec', '/usr/bin/env', `PATH=${info.loginPath}`, file, ...args],
    {
      encoding: 'buffer',
      timeout: options.timeout ?? 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, WSL_UTF8: '1' }
    }
  );
  return {
    stdout: decodeWslOutput(result.stdout as Buffer),
    stderr: decodeWslOutput(result.stderr as Buffer)
  };
}
