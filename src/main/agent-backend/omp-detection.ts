/** Detects the configured OMP CLI and its model catalog without registering IPC handlers. */
import path from 'path';
import os from 'os';
import type { OmpDetection } from '../../shared/types/omp-detection';
import { existsAsync, findExecutableAsync } from '../env-utils';
import { runTool } from '../platform/runtime-exec';
import { getAgentBackendSettings } from './settings';
import { refreshOmpRoles } from './omp-roles';
import { parseOmpModels, parseOmpVersion } from './omp-detect-parse';

const VERSION_TIMEOUT_MS = 10_000;
const MODELS_TIMEOUT_MS = 30_000;
const COMMON_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.bun', 'bin'), path.join(os.homedir(), '.local', 'bin')];

/** The omp executable: the configured command, PATH (augmented), then common install dirs */
async function resolveOmpPath(command: string): Promise<string | null> {
  if (path.isAbsolute(command)) return (await existsAsync(command)) ? command : null;
  const found = await findExecutableAsync(command);
  if (found) return found;
  for (const dir of COMMON_DIRS) {
    const candidate = path.join(dir, command);
    if (await existsAsync(candidate)) return candidate;
  }
  return null;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function detectOmp(): Promise<OmpDetection> {
  const command = getAgentBackendSettings().omp.command || 'omp';
  const ompPath = await resolveOmpPath(command);
  if (!ompPath) return { installed: false, models: [] };

  let version: string | undefined;
  try {
    const { stdout } = await runTool('claude', ['--version'], { command: ompPath, timeout: VERSION_TIMEOUT_MS });
    version = parseOmpVersion(stdout);
  } catch (error) {
    return { installed: false, path: ompPath, models: [], error: errorMessage(error) };
  }

  try {
    let stdout: string;
    try {
      ({ stdout } = await runTool('claude', ['models', '--json'], { command: ompPath, timeout: MODELS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }));
    } catch {
      ({ stdout } = await runTool('claude', ['models'], { command: ompPath, timeout: MODELS_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }));
    }
    // The role cache is read again with every detection (a refresh in Settings > Agents)
    const roles = await refreshOmpRoles();
    return { installed: true, path: ompPath, version, models: parseOmpModels(stdout), ...(roles ? { roles } : {}) };
  } catch (error) {
    return { installed: true, path: ompPath, version, models: [], error: errorMessage(error) };
  }
}

