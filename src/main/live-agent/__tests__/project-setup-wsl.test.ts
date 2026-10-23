/**
 * Live agent with Claude Code inside WSL: the hook command works both natively and inside WSL
 * (through interop), and the hook script maps the Linux paths of a WSL session to Windows paths
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platformRef = vi.hoisted(() => ({ windows: true }));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => platformRef.windows,
}));
vi.mock('../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { buildHookCommand, getHookScriptContent } from '../project-setup';

const execFileAsync = promisify(execFile);
const EXE = 'C:\\Program Files\\Workbench\\Workbench.exe';
const SCRIPT = 'C:\\Users\\me\\proj\\.workbench\\flow\\hook.cjs';

afterEach(() => {
  platformRef.windows = true;
});

describe('hook command', () => {
  it('runs the executable natively and, inside WSL, by its Linux path through interop', () => {
    const command = buildHookCommand(EXE, SCRIPT);
    const native = 'ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Workbench/Workbench.exe" "C:/Users/me/proj/.workbench/flow/hook.cjs"';
    expect(command).toBe(
      'if [ -n "$WSL_DISTRO_NAME" ]; then '
      + 'WSLENV="ELECTRON_RUN_AS_NODE:WORKBENCH_TERMINAL_ID:WSL_DISTRO_NAME:WORKBENCH_WSL_MOUNT_ROOT${WSLENV:+:$WSLENV}" '
      + "WORKBENCH_WSL_MOUNT_ROOT='/mnt/' ELECTRON_RUN_AS_NODE=1 '/mnt/c/Program Files/Workbench/Workbench.exe' "
      + "'C:/Users/me/proj/.workbench/flow/hook.cjs'; "
      + `else ${native}; fi`
    );
    // Still recognized as ours (settings migration, removal)
    expect(command.replace(/\\/g, '/')).toContain('/.workbench/flow/hook.cjs');
  });

  it('uses the mount root WSL was detected with', () => {
    expect(buildHookCommand(EXE, SCRIPT, '/win')).toContain("WORKBENCH_WSL_MOUNT_ROOT='/win/' ELECTRON_RUN_AS_NODE=1 '/win/c/Program Files/");
  });

  it('keeps the plain command on macOS and Linux', () => {
    platformRef.windows = false;
    expect(buildHookCommand('/opt/Workbench/workbench', '/home/me/proj/.workbench/flow/hook.cjs'))
      .toBe('ELECTRON_RUN_AS_NODE=1 "/opt/Workbench/workbench" "/home/me/proj/.workbench/flow/hook.cjs"');
  });

  // Runs the generated command in a real POSIX shell (Claude Code runs hooks with /bin/sh, and with
  // Git Bash on Windows), a fake executable standing in for Workbench's
  describe.skipIf(process.platform === 'win32')('in a shell', () => {
    let root = '';
    afterEach(() => {
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    /** A fake Workbench.exe at `<root>/c/Workbench.exe` (the Linux path of C:\Workbench.exe with this mount root) */
    function setUp(): { command: string; mountRoot: string } {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-command-'));
      const exe = path.join(root, 'c', 'Workbench.exe');
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$ELECTRON_RUN_AS_NODE" "$WSLENV" "$WORKBENCH_WSL_MOUNT_ROOT" "$*"\n', { mode: 0o755 });
      const mountRoot = `${root}/`;
      return { command: buildHookCommand('C:\\Workbench.exe', 'C:\\proj\\.workbench\\flow\\hook.cjs', mountRoot), mountRoot };
    }

    it('starts the executable by its Linux path inside WSL, with the variables WSLENV takes across', async () => {
      const { command, mountRoot } = setUp();
      const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
        env: { ...process.env, WSL_DISTRO_NAME: 'Ubuntu', WSLENV: 'EXISTING/p' },
      });
      expect(stdout.trim()).toBe(
        `1|ELECTRON_RUN_AS_NODE:WORKBENCH_TERMINAL_ID:WSL_DISTRO_NAME:WORKBENCH_WSL_MOUNT_ROOT:EXISTING/p|${mountRoot}|C:/proj/.workbench/flow/hook.cjs`
      );
    });

    it('runs the native command outside WSL', async () => {
      const { command } = setUp();
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.WSL_DISTRO_NAME;
      const failure = await execFileAsync('/bin/sh', ['-c', command], { env }).catch((error: { stderr: string }) => error);
      // The native branch names the Windows path, which doesn't exist here
      expect((failure as { stderr: string }).stderr).toContain('C:/Workbench.exe');
    });
  });
});

describe('hook script', () => {
  /**
   * Run the hook script as Workbench's executable would on Windows (win32 paths), with one live
   * relay advertised for `workspace`; resolves with what it forwarded, or null
   */
  function runHook(payload: Record<string, unknown>, workspace: string, env: Record<string, string>): Record<string, unknown> | null {
    let forwarded: Record<string, unknown> | null = null;
    const handlers: Record<string, (chunk?: string) => void> = {};
    const fakeFs = {
      readdirSync: () => ['abc-1.json'],
      readFileSync: () => JSON.stringify({ workspace, pid: 1, port: 4000 }),
      realpathSync: () => {
        throw new Error('not found');
      },
      unlinkSync: () => undefined,
    };
    const fakeHttp = {
      request: () => ({
        on: () => undefined,
        write: (body: string) => {
          forwarded = JSON.parse(body);
        },
        end: () => undefined,
      }),
    };
    class Exit extends Error {}
    const fakeProcess = {
      platform: 'win32',
      env,
      kill: () => true,
      exit: () => {
        throw new Exit();
      },
      stdin: {
        setEncoding: () => undefined,
        on: (event: string, handler: (chunk?: string) => void) => {
          handlers[event] = handler;
        },
      },
    };
    const modules: Record<string, unknown> = { fs: fakeFs, path: path.win32, http: fakeHttp };
    vm.runInNewContext(getHookScriptContent().replace(/^#!.*\n/, ''), {
      require: (name: string) => modules[name],
      process: fakeProcess,
      setTimeout: () => undefined,
      __dirname: 'C:\\proj\\.workbench\\flow',
    });
    handlers.data?.(JSON.stringify(payload));
    try {
      handlers.end?.();
    } catch (error) {
      if (!(error instanceof Exit)) throw error;
    }
    return forwarded;
  }

  it('maps the Linux paths of a session on a Windows drive to Windows paths', () => {
    const forwarded = runHook(
      { cwd: '/mnt/c/Users/me/proj', transcript_path: '/home/me/.claude/projects/-mnt-c-Users-me-proj/s.jsonl', hook_event_name: 'Stop' },
      'C:\\Users\\me\\proj',
      { WSL_DISTRO_NAME: 'Ubuntu', WORKBENCH_TERMINAL_ID: 'term-1' },
    );
    expect(forwarded).toMatchObject({
      cwd: 'C:\\Users\\me\\proj',
      transcript_path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects\\-mnt-c-Users-me-proj\\s.jsonl',
      workbench_terminal_id: 'term-1',
    });
  });

  it('maps a project inside the distribution to its \\\\wsl.localhost path', () => {
    const forwarded = runHook({ cwd: '/home/me/proj/' }, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', { WSL_DISTRO_NAME: 'Ubuntu' });
    expect(forwarded?.cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
  });

  it('honors the mount root and leaves Windows paths alone', () => {
    expect(runHook({ cwd: '/win/d/work' }, 'D:\\work', { WSL_DISTRO_NAME: 'Ubuntu', WORKBENCH_WSL_MOUNT_ROOT: '/win/' })?.cwd).toBe('D:\\work');
    expect(runHook({ cwd: 'C:\\Users\\me\\proj' }, 'C:\\Users\\me\\proj', {})?.cwd).toBe('C:\\Users\\me\\proj');
  });

  it('forwards nothing for a session outside the workspace', () => {
    expect(runHook({ cwd: '/mnt/c/elsewhere' }, 'C:\\Users\\me\\proj', { WSL_DISTRO_NAME: 'Ubuntu' })).toBeNull();
  });
});
