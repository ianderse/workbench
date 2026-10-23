/**
 * Graphify while the app runs its tools in WSL: the distribution's graphify is found and run
 * through the runtime layer (Windows path arguments are translated there), Windows-only programs
 * on the appended Windows PATH don't count, and the install command uses the distribution's
 * uv / pipx / python3.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const mocks = vi.hoisted(() => ({
  found: new Map<string, string>(),
  runTool: vi.fn(),
  findExecutableAsync: vi.fn(),
  getAugmentedEnvAsync: vi.fn(),
}));

vi.mock('../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  isWslRuntime: () => true,
  getWslInfo: () => ({ distro: 'Ubuntu', mountRoot: '/mnt/', home: '/home/me', tools: { graphify: { path: null, version: null } } }),
  toRuntimePath: (p: string) => p,
}));
vi.mock('../platform/wsl-exec-basic', () => ({
  execInWsl: async (_file: string, args: string[]) => {
    const name = args[args.length - 1];
    const found = mocks.found.get(name);
    if (!found) throw Object.assign(new Error('not found'), { code: 1 });
    return { stdout: `${found}\n`, stderr: '' };
  },
}));
vi.mock('../platform/runtime-exec', () => ({ runTool: mocks.runTool }));
vi.mock('../platform/claude-home', () => ({
  getClaudeHome: () => '\\\\wsl.localhost\\Ubuntu\\home\\me',
  joinClaudeHome: (...parts: string[]) => ['\\\\wsl.localhost\\Ubuntu\\home\\me', ...parts].join('\\'),
}));
vi.mock('../env-utils', () => ({
  findExecutableAsync: mocks.findExecutableAsync,
  getAugmentedEnvAsync: mocks.getAugmentedEnvAsync,
}));
vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: vi.fn() }));

import { buildGraphifyIndex, detectGraphify, getGraphifyInstallCommand } from '../graphify';

let project: string;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.found.clear();
  mocks.runTool.mockImplementation(async (_tool: string, args: string[]) => ({
    stdout: args[0] === '--version' ? 'graphify 0.9.92' : 'wrote graph.json: 28 nodes, 38 edges, 6 communities',
    stderr: '',
  }));
  project = mkdtempSync(path.join(os.tmpdir(), 'graphify-wsl-'));
  mkdirSync(path.join(project, '.workbench', 'knowledge'), { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('graphify in WSL', () => {
  it("finds the distribution's graphify, not a Windows one", async () => {
    mocks.found.set('graphify', '/mnt/c/Users/me/.local/bin/graphify.exe');
    expect(await detectGraphify(true)).toBeNull();

    mocks.found.set('graphify', '/home/me/.local/bin/graphify');
    expect(await detectGraphify(true)).toEqual({ path: '/home/me/.local/bin/graphify', version: '0.9.92' });
    expect(mocks.findExecutableAsync).not.toHaveBeenCalled();
    expect(mocks.runTool).toHaveBeenCalledWith('python', ['--version'], expect.objectContaining({ command: '/home/me/.local/bin/graphify' }));
  });

  it('builds through the runtime layer with host paths (translated there) and the app environment', async () => {
    mocks.found.set('graphify', '/home/me/.local/bin/graphify');
    await detectGraphify(true);
    await buildGraphifyIndex(project);

    const memoryDir = path.join(project, '.workbench', 'knowledge');
    const extract = mocks.runTool.mock.calls.find(([, args]) => args[0] === 'extract');
    expect(extract?.[1]).toEqual(['extract', project, '--code-only', '--allow-dedup-shrink', '--out', memoryDir]);
    expect(extract?.[2]).toMatchObject({ command: '/home/me/.local/bin/graphify', cwd: project });
    expect(extract?.[2].env.GRAPHIFY_OUT).toBe(path.join(memoryDir, 'graphify-out'));
    // Windows PATH changes stay on the Windows side
    expect(mocks.getAugmentedEnvAsync).not.toHaveBeenCalled();
  });

  it('installs with the tools inside WSL', async () => {
    expect(await getGraphifyInstallCommand(false)).toBe('python3 -m pip install --user --upgrade graphifyy');
    mocks.found.set('pipx', '/usr/bin/pipx');
    expect(await getGraphifyInstallCommand(false)).toBe('pipx install graphifyy');
    mocks.found.set('uv', '/home/me/.local/bin/uv');
    expect(await getGraphifyInstallCommand(true)).toBe('uv tool upgrade graphifyy');
    expect(mocks.findExecutableAsync).not.toHaveBeenCalled();
  });
});
