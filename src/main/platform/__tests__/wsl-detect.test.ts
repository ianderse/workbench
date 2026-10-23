/**
 * WSL detection: wsl.exe output decoding and parsing, the probe's marked output, and failures
 * mapped to the reasons Settings shows
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = vi.hoisted(() => ({ windows: true }));
vi.mock('../index', () => ({ isWindows: () => platform.windows }));
vi.mock('../paths', () => ({ getWindowsShellPaths: () => ({ wsl: ['wsl.exe'] }) }));

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: execFileMock };
});

import {
  checkWslAvailable,
  classifyWslListFailure,
  decodeWslOutput,
  parseDistroList,
  parseProbeOutput,
  parseVerboseList,
  resetWslAvailabilityCache,
  WSL_PROBE_SCRIPT
} from '../wsl-detect';

const utf16 = (text: string, bom = true) =>
  Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);

type ExecCallback = (error: unknown, result?: { stdout: Buffer; stderr: Buffer }) => void;

/** Answer `wsl.exe -l -q` and `-l -v` calls */
function answerWsl(handler: (args: string[]) => { stdout?: Buffer; error?: unknown }) {
  execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
    const { stdout, error } = handler(args);
    if (error) callback(error);
    else callback(null, { stdout: stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0) });
  });
}

const M = '\x1e';
const probeOutput = (lines: Record<string, string>, noise = '') =>
  `${noise}${Object.entries(lines)
    .map(([key, value]) => `${M}${key}=${value}`)
    .join('\n')}\n${noise}`;

describe('decodeWslOutput', () => {
  it('decodes UTF-16LE with a byte order mark and NULs', () => {
    expect(decodeWslOutput(utf16('Ubuntu\r\ndocker-desktop\r\n'))).toBe('Ubuntu\r\ndocker-desktop\r\n');
    expect(decodeWslOutput(utf16('Debian\r\n', false))).toBe('Debian\r\n');
  });

  it('decodes UTF-8 (WSL_UTF8=1) and strips stray NULs', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\r\n', 'utf8'))).toBe('Ubuntu\r\n');
    expect(decodeWslOutput('U\0b\0u\0n\0t\0u\0')).toBe('Ubuntu');
    expect(decodeWslOutput(undefined)).toBe('');
  });
});

describe('list parsing', () => {
  it('reads distribution names from -l -q', () => {
    expect(parseDistroList('Ubuntu\r\ndocker-desktop\r\n\r\n')).toEqual(['Ubuntu', 'docker-desktop']);
  });

  it('reads the default distribution and version from -l -v', () => {
    const text = '  NAME              STATE           VERSION\r\n* Ubuntu-22.04      Running         2\r\n  docker-desktop    Stopped         2\r\n  Legacy            Stopped         1\r\n';
    expect(parseVerboseList(text)).toEqual([
      { name: 'Ubuntu-22.04', isDefault: true, state: 'Running', version: 2 },
      { name: 'docker-desktop', isDefault: false, state: 'Stopped', version: 2 },
      { name: 'Legacy', isDefault: false, state: 'Stopped', version: 1 }
    ]);
  });
});

describe('classifyWslListFailure', () => {
  it('maps a missing wsl.exe to not installed', () => {
    expect(classifyWslListFailure(Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' })).reason).toBe('not-installed');
  });

  it('maps a timeout', () => {
    expect(classifyWslListFailure(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })).reason).toBe('timeout');
  });

  it('reads wsl.exe\'s UTF-16 messages', () => {
    const noDistro = Object.assign(new Error('Command failed'), {
      code: 4294967295,
      stdout: utf16('Windows Subsystem for Linux has no installed distributions.\r\n')
    });
    expect(classifyWslListFailure(noDistro)).toEqual({
      reason: 'no-distro',
      detail: 'Windows Subsystem for Linux has no installed distributions.'
    });

    const notInstalled = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: utf16("Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.")
    });
    expect(classifyWslListFailure(notInstalled).reason).toBe('not-installed');
    expect(classifyWslListFailure(Object.assign(new Error('boom'), { code: 5 })).reason).toBe('error');
  });
});

describe('checkWslAvailable', () => {
  beforeEach(() => {
    platform.windows = true;
    execFileMock.mockReset();
    resetWslAvailabilityCache();
  });

  it('is available with a distribution, picking the default one and its version', async () => {
    answerWsl((args) =>
      args.includes('-q')
        ? { stdout: utf16('docker-desktop\r\nUbuntu\r\nDebian\r\n') }
        : { stdout: utf16('  NAME STATE VERSION\r\n  docker-desktop Stopped 2\r\n* Ubuntu Running 2\r\n  Debian Stopped 1\r\n') }
    );
    const result = await checkWslAvailable();
    expect(result).toMatchObject({ available: true, distros: ['Ubuntu', 'Debian'], defaultDistro: 'Ubuntu', version: 2 });
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ windowsHide: true, env: expect.objectContaining({ WSL_UTF8: '1' }) });
  });

  it('keeps the result until refreshed', async () => {
    answerWsl(() => ({ stdout: Buffer.from('Ubuntu\n') }));
    await checkWslAvailable();
    await checkWslAvailable();
    expect(execFileMock).toHaveBeenCalledTimes(2); // -l -q and -l -v once
    await checkWslAvailable({ refresh: true });
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it('has no distribution when only Docker Desktop\'s are installed', async () => {
    answerWsl(() => ({ stdout: utf16('docker-desktop\r\ndocker-desktop-data\r\n') }));
    expect(await checkWslAvailable()).toMatchObject({ available: false, reason: 'no-distro' });
  });

  it('is unavailable when wsl.exe times out', async () => {
    answerWsl(() => ({ error: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) }));
    expect(await checkWslAvailable()).toMatchObject({ available: false, reason: 'timeout', distros: [] });
  });

  it('is not checked off Windows', async () => {
    platform.windows = false;
    expect(await checkWslAvailable()).toMatchObject({ available: false, reason: 'not-windows' });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('parseProbeOutput', () => {
  const base = {
    user: 'me',
    home: '/home/me',
    shell: '/bin/bash',
    mount: '/mnt/c/',
    path: '/home/me/.local/bin:/usr/bin:/mnt/c/Windows/system32:/mnt/c/Program Files/nodejs:/bin',
    'tool.claude': '/home/me/.local/bin/claude',
    'ver.claude': '2.1.3 (Claude Code)',
    'tool.git': '/usr/bin/git',
    'ver.git': 'git version 2.43.0',
    'tool.gh': '',
    net: 'nat',
    done: '1'
  };

  it('reads the marked lines and ignores rc-file noise around them', () => {
    const noise = 'Welcome to Ubuntu!\nnvm: loading...\n';
    const result = parseProbeOutput(probeOutput(base, noise), 'Ubuntu');
    expect(result).toMatchObject({
      distro: 'Ubuntu',
      user: 'me',
      home: '/home/me',
      loginShell: '/bin/bash',
      mountRoot: '/mnt/',
      networkingMode: 'nat',
      loginPath: '/home/me/.local/bin:/usr/bin:/bin'
    });
    expect(result.tools.claude).toEqual({ path: '/home/me/.local/bin/claude', version: '2.1.3' });
    expect(result.tools.git).toEqual({ path: '/usr/bin/git', version: '2.43.0' });
    expect(result.tools.gh).toEqual({ path: null, version: null });
    expect(result.tools.graphify).toEqual({ path: null, version: null });
  });

  it('reads whether WSL interop is on, assuming it is when the probe gives no answer', () => {
    expect(parseProbeOutput(probeOutput({ ...base, interop: '0' }), 'Ubuntu').interop).toBe(false);
    expect(parseProbeOutput(probeOutput({ ...base, interop: '1' }), 'Ubuntu').interop).toBe(true);
    expect(parseProbeOutput(probeOutput(base), 'Ubuntu').interop).toBe(true);
  });

  it('rejects tools under the mount root (Windows shims)', () => {
    const result = parseProbeOutput(
      probeOutput({ ...base, 'tool.claude': '/mnt/c/Users/me/AppData/Roaming/npm/claude', 'ver.claude': '2.0.0' }),
      'Ubuntu'
    );
    expect(result.tools.claude).toEqual({ path: null, version: null });
  });

  it('honors a custom mount root', () => {
    const result = parseProbeOutput(
      probeOutput({ ...base, mount: '/c/', path: '/usr/bin:/c/Windows:/home/me/bin', 'tool.git': '/c/Git/bin/git' }),
      'Ubuntu'
    );
    expect(result.mountRoot).toBe('/');
    expect(result.loginPath).toBe('/usr/bin:/home/me/bin');
    expect(result.tools.git.path).toBeNull();
  });

  it('reads output with NULs mixed in', () => {
    const result = parseProbeOutput(probeOutput(base).split('').join('\0'), 'Ubuntu');
    expect(result.home).toBe('/home/me');
  });

  it('throws when the probe did not finish', () => {
    const { done: _done, ...unfinished } = base;
    expect(() => parseProbeOutput(probeOutput(unfinished), 'Ubuntu')).toThrow();
    expect(() => parseProbeOutput('bash: command not found', 'Ubuntu')).toThrow();
  });
});

describe('WSL_PROBE_SCRIPT', () => {
  it('looks up every tool and marks its lines', () => {
    for (const tool of ['claude', 'git', 'gh', 'glab', 'python3', 'node', 'npx', 'graphify']) {
      expect(WSL_PROBE_SCRIPT).toContain(tool);
    }
    expect(WSL_PROBE_SCRIPT).toContain("printf '\\036'");
    expect(WSL_PROBE_SCRIPT).toContain('out done 1');
    expect(WSL_PROBE_SCRIPT).not.toContain('undefined');
  });
});
