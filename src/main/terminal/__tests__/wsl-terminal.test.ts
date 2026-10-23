/**
 * Agent windows in WSL (wsl-terminal.ts):
 * - the login shell decides how typed lines reach it (POSIX shells directly, fish through bash -c,
 *   other shells get bash instead)
 * - fish quoting keeps the POSIX line byte for byte
 * - the window's environment reaches Linux through WSLENV: what the app adds, with path values
 *   translated, never PATH or the tool wrapper's WB_PATH
 */
import { describe, it, expect, vi } from 'vitest';

const INFO = {
  distro: 'Ubuntu',
  user: 'me',
  home: '/home/me',
  loginShell: '/usr/bin/fish',
  loginPath: '/home/me/.local/bin:/usr/bin:/bin',
  mountRoot: '/mnt/',
  networkingMode: 'nat',
  tools: {} as Record<string, { path: string | null; version: string | null }>,
};

vi.mock('../../platform/shell-runtime', async () => {
  const { windowsToWsl } = await vi.importActual<typeof import('../../platform/wsl-paths')>('../../platform/wsl-paths');
  return {
    whenShellRuntimeReady: async () => ({}),
    isWslRuntime: () => true,
    getWslInfo: () => INFO,
    toRuntimePath: (p: string) => windowsToWsl(p, INFO) ?? p,
  };
});
vi.mock('../../platform/wsl-detect', () => ({ getWslExePath: () => 'C:\\Windows\\System32\\wsl.exe' }));
vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: vi.fn() }));
vi.mock('../../env-utils', () => ({ getSpawnCommand: (c: string) => c, shouldUseShell: () => false }));

import {
  buildWslPtyEnv,
  buildWslPtyLaunch,
  classifyWslLoginShell,
  quoteForFish,
  wrapLineForFish,
} from '../wsl-terminal';

describe('classifyWslLoginShell', () => {
  it('types POSIX lines into POSIX shells', () => {
    for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/sh', '/bin/dash', '/bin/ksh', '', undefined]) {
      expect(classifyWslLoginShell(shell)).toBe('posix');
    }
  });

  it('recognizes fish and other non-POSIX shells', () => {
    expect(classifyWslLoginShell('/usr/bin/fish')).toBe('fish');
    expect(classifyWslLoginShell('/usr/bin/nu')).toBe('other');
    expect(classifyWslLoginShell('/usr/bin/xonsh')).toBe('other');
  });
});

describe('fish quoting', () => {
  it('escapes only backslashes and single quotes', () => {
    expect(quoteForFish(`cd '/mnt/c/it'\\''s' && printf '\\033'`)).toBe(
      `'cd \\'/mnt/c/it\\'\\\\\\'\\'s\\' && printf \\'\\\\033\\''`
    );
    expect(quoteForFish('$HOME "x" `y`; z')).toBe(`'$HOME "x" \`y\`; z'`);
  });

  it('runs the line through bash, kept out of history by a leading space', () => {
    expect(wrapLineForFish("cd '/mnt/c/repo' && claude")).toBe(` bash -c 'cd \\'/mnt/c/repo\\' && claude'`);
  });
});

describe('buildWslPtyEnv', () => {
  it('forwards what the app added, path values translated, never PATH', () => {
    const env = buildWslPtyEnv(
      {
        ...process.env,
        CLAUDE_CONFIG_DIR: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-work',
        GRAPHIFY_OUT: 'C:\\Users\\me\\repo\\.workbench\\knowledge',
        WORKBENCH_TERMINAL_ID: 'term-1',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
        PATH: 'C:\\Windows\\System32',
      },
      INFO
    );
    const listed = env.WSLENV.split(':');
    expect(listed).toEqual(
      expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'GRAPHIFY_OUT', 'WORKBENCH_TERMINAL_ID', 'TERM', 'COLORTERM'])
    );
    expect(listed).not.toContain('PATH');
    expect(listed).not.toContain('WB_PATH');
    expect(env.WB_PATH).toBeUndefined();
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-work');
    expect(env.GRAPHIFY_OUT).toBe('/mnt/c/Users/me/repo/.workbench/knowledge');
  });

  it('always forwards TERM and COLORTERM, even when the app runs with the same values', () => {
    const saved = { TERM: process.env.TERM, COLORTERM: process.env.COLORTERM };
    process.env.TERM = 'xterm-256color';
    process.env.COLORTERM = 'truecolor';
    try {
      const env = buildWslPtyEnv({ ...process.env }, INFO);
      expect(env.WSLENV.split(':')).toEqual(expect.arrayContaining(['TERM', 'COLORTERM']));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('buildWslPtyLaunch', () => {
  it("starts the login shell in the window's directory inside WSL, from the Windows home", () => {
    const launch = buildWslPtyLaunch('C:\\Users\\me\\my repo', { TERM: 'xterm-256color' }, INFO, 'C:\\Users\\me');
    expect(launch.file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(launch.args).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/Users/me/my repo']);
    expect(launch.cwd).toBe('C:\\Users\\me');
    expect(launch.wrapInBash).toBe(true);
  });

  it('opens the Linux home without a directory, and bash for shells that take neither syntax', () => {
    const launch = buildWslPtyLaunch(undefined, {}, { ...INFO, loginShell: '/usr/bin/nu' }, 'C:\\Users\\me');
    expect(launch.args).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', '/bin/bash', '-l']);
    expect(launch.wrapInBash).toBe(false);
  });
});
