/** Finding the `omp` executable */

import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getExecutableExtension, getPathDelimiter } from '../platform';

/** Directories searched for `omp` when the app (started from Finder/Explorer) has a minimal PATH */
function extraSearchDirs(): string[] {
  const home = os.homedir();
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.bun', 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin')];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the OMP executable (settings command, PATH, then common install folders) */
export async function resolveOmpCommand(configured: string | undefined, envPath: string | undefined = process.env.PATH): Promise<string> {
  const command = configured?.trim() || 'omp';
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return command;
  const ext = getExecutableExtension();
  const names = ext ? [`${command}${ext}`, `${command}.cmd`, command] : [command];
  const dirs = [...(envPath ?? '').split(getPathDelimiter()).filter(Boolean), ...extraSearchDirs()];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return command; // let the spawn fail with a readable "not found"
}
