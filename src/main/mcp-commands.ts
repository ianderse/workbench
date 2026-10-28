/**
 * Commands MCP servers need
 * =========================
 *
 * A stdio MCP server can only start when its command is installed where Claude Code runs (the
 * built-in connectors need npx; custom servers name their own command). Lookups are cached;
 * `refresh` looks again (after installing something). See mcp-availability.ts.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { isWindows } from './platform';
import { getWslInfo, whenShellRuntimeReady } from './platform/shell-runtime';
import { execInWsl } from './platform/wsl-exec-basic';
import { isUnderMountRoot } from './platform/wsl-detect';
import { getWhereExePath } from './utils/windows-paths';
import { getToolInfoAsync } from './cli-tool-manager';
import { getToolEnvAsync } from './cli-utils';

const execFileAsync = promisify(execFile);

/**
 * Where a command lives inside WSL (`command -v` with the login PATH), when the app runs its
 * tools there. `windowsOnly` when only a Windows program of that name was found (on the Windows
 * PATH WSL appends), which Claude Code inside WSL can't use as an MCP server.
 */
export async function findWslCommand(command: string): Promise<{ path: string | null; windowsOnly: boolean }> {
  const wsl = getWslInfo();
  if (!wsl) return { path: null, windowsOnly: false };
  let found = '';
  try {
    // Without the login PATH's Windows entries removed, so a Windows-only program can be named
    const { stdout } = await execInWsl('/bin/sh', ['-c', 'command -v "$1"', 'sh', command], { timeout: 15000 });
    found = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  } catch {
    return { path: null, windowsOnly: false };
  }
  if (!found.startsWith('/')) return { path: null, windowsOnly: false };
  if (isUnderMountRoot(found, wsl.mountRoot)) return { path: null, windowsOnly: true };
  return { path: found, windowsOnly: false };
}

async function lookUp(command: string): Promise<boolean> {
  await whenShellRuntimeReady();
  if (getWslInfo()) return (await findWslCommand(command)).path !== null;
  // node and npx come from the Node.js detection (version managers included): npx sits next to node
  if (command === 'node' || command === 'npx') {
    const node = await getToolInfoAsync('node');
    if (!node.found || !node.path) return false;
    return command === 'node' || existsSync(path.join(path.dirname(node.path), isWindows() ? 'npx.cmd' : 'npx'));
  }
  try {
    const { stdout } = await execFileAsync(isWindows() ? getWhereExePath() : 'which', [command], {
      timeout: 5000,
      windowsHide: true,
      env: await getToolEnvAsync(),
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const lookups = new Map<string, Promise<boolean>>();

/** Whether a command is installed where Claude Code runs (cached; `refresh` looks again) */
export function isCommandAvailable(command: string, options: { refresh?: boolean } = {}): Promise<boolean> {
  if (options.refresh) lookups.delete(command);
  let lookup = lookups.get(command);
  if (!lookup) {
    lookup = lookUp(command);
    lookups.set(command, lookup);
  }
  return lookup;
}
