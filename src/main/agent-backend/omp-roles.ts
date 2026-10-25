/**
 * OMP model roles
 * ===============
 *
 * `omp --model @<role>` runs the model in OMP's `modelRoles.<role>`, and fails with "Model not found"
 * for a role that is not configured. Workbench therefore reads the roles the user's OMP config
 * defines (`omp config list --json`) and only uses those. The result is cached for the app session
 * and read again after REFRESH_MS or when Settings > Agents detects OMP; reading never blocks a run
 * (until the first read finishes, runs simply omit `--model`).
 */

import { appLog } from '../app-logger';
import { runTool } from '../platform/runtime-exec';
import { getAgentBackendSettings } from './settings';
import { resolveOmpCommand } from './omp-command';
import type { OmpRoleMap } from './omp-args';

const REFRESH_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const READ_TIMEOUT_MS = 20_000;

/** Role -> model selector from `omp config list --json` output; undefined when the output is not usable */
export function parseOmpRoles(output: string): Record<string, string> | undefined {
  try {
    const data = JSON.parse(output) as { modelRoles?: { value?: unknown } } | null;
    const value = data?.modelRoles?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const roles: Record<string, string> = {};
    for (const [name, selector] of Object.entries(value as Record<string, unknown>)) {
      if (typeof selector === 'string' && selector.trim()) roles[name] = selector.trim();
    }
    return roles;
  } catch {
    return undefined;
  }
}

let cached: { roles: Record<string, string>; at: number } | undefined;
let nextTryAt = 0;
let loading: Promise<Record<string, string> | undefined> | undefined;

/** Read the roles from OMP now (async); keeps the previous value when the read fails */
export function refreshOmpRoles(): Promise<Record<string, string> | undefined> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const command = await resolveOmpCommand(getAgentBackendSettings().omp.command);
      const { stdout } = await runTool('claude', ['config', 'list', '--json'], { command, timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      const roles = parseOmpRoles(stdout);
      if (!roles) {
        appLog.warn('[OMP] Could not read model roles from `omp config list --json`');
        nextTryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
        return cached?.roles;
      }
      cached = { roles, at: Date.now() };
      nextTryAt = Date.now() + REFRESH_MS;
      return roles;
    } catch (error) {
      appLog.warn('[OMP] Could not read model roles:', error);
      nextTryAt = Date.now() + RETRY_AFTER_FAILURE_MS;
      return cached?.roles;
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

/**
 * Roles known so far, without waiting. Starts a background read when none was made yet or the last
 * one is old, so the next run sees them.
 */
export function getOmpRoles(): OmpRoleMap | undefined {
  if (Date.now() >= nextTryAt && !loading) void refreshOmpRoles();
  return cached?.roles;
}

/** Test hook */
export function resetOmpRolesForTests(roles?: Record<string, string>): void {
  cached = roles ? { roles, at: Date.now() } : undefined;
  nextTryAt = roles ? Date.now() + REFRESH_MS : 0;
  loading = undefined;
}
