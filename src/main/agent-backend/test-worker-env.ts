/** Vitest generations use different worker variables; nested agent tools inherit all of them. */
const MAXIMUM_TEST_WORKERS = 2;
const DEFAULT_TEST_WORKERS = 1;
export const TEST_WORKER_ENV_KEYS = [
  'VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS', 'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS',
] as const;

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * One worker by default, at most two when explicitly configured. This bounds each Vitest
 * invocation, not the number of simultaneous test commands. Apply at the spawn boundary so
 * profile merging, resumed CLI processes and nested tools cannot miss these defaults.
 */
export function withBoundedTestWorkers(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string') env[key] = value;
  for (const key of ['VITEST_MAX_WORKERS', 'VITEST_MAX_THREADS', 'VITEST_MAX_FORKS'] as const) {
    env[key] = String(Math.min(positiveInteger(env[key]) ?? DEFAULT_TEST_WORKERS, MAXIMUM_TEST_WORKERS));
  }
  for (const [minimum, maximum] of [['VITEST_MIN_THREADS', 'VITEST_MAX_THREADS'], ['VITEST_MIN_FORKS', 'VITEST_MAX_FORKS']] as const) {
    env[minimum] = String(Math.min(positiveInteger(env[minimum]) ?? 1, Number(env[maximum])));
  }
  // runtime-exec normally forwards only values changed from process.env into WSL. Explicit
  // entries keep these limits even when the host already inherited identical bounded values.
  const inheritedForwarding = Object.entries(env).filter(([key]) => key.toUpperCase() === 'WSLENV');
  for (const [key] of inheritedForwarding) delete env[key];
  const listed = new Set<string>();
  const forwarded = inheritedForwarding.flatMap(([, value]) => value.split(':')).filter(Boolean)
    .filter((entry) => {
      if (TEST_WORKER_ENV_KEYS.some((key) => entry.split('/')[0].toUpperCase() === key)) return false;
      const identity = entry.toUpperCase();
      if (listed.has(identity)) return false;
      listed.add(identity);
      return true;
    });
  env.WSLENV = [...forwarded, ...TEST_WORKER_ENV_KEYS].join(':');
  return env;
}
