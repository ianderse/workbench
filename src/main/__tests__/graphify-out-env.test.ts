/**
 * graphify takes GRAPHIFY_OUT over --out, so a build has to name the project's own output
 * directory in the environment: an app started from a shell that already has GRAPHIFY_OUT (a
 * Workbench terminal sets one) would otherwise write every project's graph into that one project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

/** The stale value an app inherits from the shell it was started in */
const INHERITED_OUT = '/home/someone/other-project/.workbench/knowledge/graphify-out';

const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];

vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    calls.push({ args, env: options.env });
    const stdout = args[0] === '--version' ? 'graphify 0.9.92' : 'wrote graph.json: 28 nodes, 38 edges, 6 communities';
    callback(null, { stdout, stderr: '' });
  },
}));

vi.mock('../env-utils', () => ({
  findExecutableAsync: async () => '/usr/bin/graphify',
  getAugmentedEnvAsync: async () => ({ PATH: '/usr/bin', GRAPHIFY_OUT: INHERITED_OUT }),
}));

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));

import { buildGraphifyIndex } from '../graphify';

let project: string;

beforeEach(() => {
  calls.length = 0;
  project = mkdtempSync(path.join(os.tmpdir(), 'graphify-out-env-'));
  mkdirSync(path.join(project, '.workbench', 'knowledge'), { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('a build names its own output directory', () => {
  it('overrides an inherited GRAPHIFY_OUT for extract and cluster-only', async () => {
    await buildGraphifyIndex(project);

    const outDir = path.join(project, '.workbench', 'knowledge', 'graphify-out');
    const builds = calls.filter((call) => call.args[0] === 'extract' || call.args[0] === 'cluster-only');
    expect(builds.map((call) => call.args[0])).toEqual(['extract', 'cluster-only']);
    for (const call of builds) {
      expect(call.env.GRAPHIFY_OUT).toBe(outDir);
    }
  });
});
