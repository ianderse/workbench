import { describe, expect, it, vi } from 'vitest';
import { TEST_WORKER_ENV_KEYS, withBoundedTestWorkers } from '../test-worker-env';
import { buildWslEnv } from '../../platform/runtime-exec';

describe('agent test-worker environment', () => {
  it('defaults all supported Vitest generations to one worker without changing the source', () => {
    const source = { KEEP: 'unchanged', EMPTY: undefined };
    const env = withBoundedTestWorkers(source);
    for (const key of TEST_WORKER_ENV_KEYS) expect(env[key]).toBe('1');
    expect(env.KEEP).toBe('unchanged');
    expect(source).toEqual({ KEEP: 'unchanged', EMPTY: undefined });
  });

  it('keeps positive lower values, caps requested worker counts at two and reconciles minima', () => {
    const env = withBoundedTestWorkers({
      VITEST_MAX_WORKERS: '1', VITEST_MAX_THREADS: '13', VITEST_MIN_THREADS: '15',
      VITEST_MAX_FORKS: '2', VITEST_MIN_FORKS: '1',
    });
    expect(env).toMatchObject({ VITEST_MAX_WORKERS: '1', VITEST_MAX_THREADS: '2', VITEST_MIN_THREADS: '2',
      VITEST_MAX_FORKS: '2', VITEST_MIN_FORKS: '1' });
  });

  it.each(['0', '-1', '1.5', '50%', 'Infinity', 'not-a-number', '999999999999999999999'])('replaces invalid limits %s with safe defaults', (value) => {
    const env = withBoundedTestWorkers(Object.fromEntries(TEST_WORKER_ENV_KEYS.map((key) => [key, value])));
    for (const key of TEST_WORKER_ENV_KEYS) expect(env[key]).toBe('1');
  });

  it('explicitly forwards bounded scalar limits into WSL even if the host already inherited them', () => {
    const env = withBoundedTestWorkers({ ...Object.fromEntries(TEST_WORKER_ENV_KEYS.map((key) => [key, '1'])),
      WSLENV: 'KEEP/p:vitest_max_workers/p:VITEST_MAX_THREADS/u',
    });
    expect(env.WSLENV.split(':')).toEqual(['KEEP/p', ...TEST_WORKER_ENV_KEYS]);
    expect(withBoundedTestWorkers(env)).toEqual(env);
  });

  it('normalizes WSLENV case variants before composing with runtime forwarding of inherited-identical limits', () => {
    for (const key of TEST_WORKER_ENV_KEYS) vi.stubEnv(key, '1');
    try {
      const source = { wslenv: 'KEEP/p:vitest_max_workers/p', WslEnv: 'OTHER/u:keep/p', WSLENV: 'THIRD',
        ...Object.fromEntries(TEST_WORKER_ENV_KEYS.map((key) => [key, '1'])) };
      const bounded = withBoundedTestWorkers(source);
      expect(Object.keys(bounded).filter((key) => key.toUpperCase() === 'WSLENV')).toEqual(['WSLENV']);
      expect(bounded.WSLENV.split(':')).toEqual(['KEEP/p', 'OTHER/u', 'THIRD', ...TEST_WORKER_ENV_KEYS]);
      const runtime = buildWslEnv(bounded, '/usr/bin');
      expect(runtime.WSLENV!.split(':')).toEqual(expect.arrayContaining(['KEEP/p', 'OTHER/u', 'THIRD', ...TEST_WORKER_ENV_KEYS]));
      for (const key of TEST_WORKER_ENV_KEYS) expect(runtime[key]).toBe('1');
    } finally { vi.unstubAllEnvs(); }
  });
});
