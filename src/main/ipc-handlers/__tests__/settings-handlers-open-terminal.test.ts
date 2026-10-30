/**
 * SHELL_OPEN_TERMINAL: opening a terminal in a folder.
 *
 * The emulator is started detached and never waited on (its window closes when the user closes
 * it, and an IPC handler may not block), but an emulator that starts and then gives up -- the way
 * one installed without a display or a session bus does -- counts as a failure, so the walk
 * through the Linux candidates moves on to the next one. An emulator slower to give up than the
 * grace period has already been reported as open, which the handler cannot take back and does not
 * try to work around: a failure that late is indistinguishable from the user closing the window,
 * so it is logged and nothing is started in its place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: vi.fn()
  },
  dialog: {},
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false },
  shell: {},
  session: {},
  BrowserWindow: { fromWebContents: vi.fn() }
}));

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true }))
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock
}));

const platform = vi.hoisted(() => ({ mac: false, windows: false }));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isMacOS: () => platform.mac,
  isWindows: () => platform.windows,
  isLinux: () => !platform.mac && !platform.windows
}));

const wsl = vi.hoisted(() => ({ info: null as null | { distro: string } }));
vi.mock('../../platform/shell-runtime', () => ({
  getWslInfo: () => wsl.info,
  reprobeWslTools: vi.fn()
}));
vi.mock('../../platform/wsl-detect', () => ({ getWslExePath: () => 'C:\\Windows\\System32\\wsl.exe' }));

vi.mock('../../settings-utils', () => ({
  getSettingsPath: () => '/tmp/settings.json',
  readSettingsFile: () => ({})
}));
vi.mock('../../cli-tool-manager', () => ({
  configureTools: vi.fn(),
  getToolInfo: vi.fn(),
  getToolInfoAsync: vi.fn(),
  isPathFromWrongPlatform: vi.fn(() => false),
  preWarmToolCache: vi.fn(() => Promise.resolve())
}));
vi.mock('../../agent', () => ({ AgentManager: class {} }));
vi.mock('../../app-language', () => ({ setAppLanguage: vi.fn() }));
vi.mock('../../app-updater', () => ({ setBetaUpdates: vi.fn() }));
vi.mock('../../services/task-queue', () => ({ taskQueue: { request: vi.fn() } }));
vi.mock('../../utils/git-exec', () => ({ git: vi.fn() }));

const appLogMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }));
vi.mock('../../app-logger', () => ({ appLog: appLogMock }));

import { IPC_CHANNELS } from '../../../shared/constants';
import type { IPCResult } from '../../../shared/types';
import { registerSettingsHandlers } from '../settings-handlers';
import type { AgentManager } from '../../agent';

registerSettingsHandlers({} as AgentManager, () => null);

/**
 * What a spawned emulator does: open a window and stay, start and fail, not exist at all, give up
 * only once it has already been reported as open ('late', and 'very-late' for the slow real case,
 * a D-Bus activation that hangs until GDBus times it out around 25 s), or open a window that the
 * user closes a second later on a shell that had failed ('closed'), which is what a late failure
 * cannot be told apart from. An emulator gives up in either of the two ways a child process can
 * fail, and both can arrive late: a non-zero exit, or an `error` saying it could never be started
 * ('...-error').
 */
type Outcome =
  | 'stays'
  | 'fails'
  | 'missing'
  | 'late'
  | 'very-late'
  | 'late-error'
  | 'very-late-error'
  | 'closed';

/** How long after it started a 'late' emulator gives up, against the 400 ms grace period */
const LATE_MS = 1_000;
const VERY_LATE_MS = 25_000;

const outcomes = new Map<string, Outcome>();

/** Spawned emulators, in the order they were started */
let children: Array<EventEmitter & { unref: ReturnType<typeof vi.fn> }> = [];

/** The folder the handler is asked for, already resolved so Windows runs assert the same string */
const DIR = path.resolve('/home/me/project');

/** The commands spawn was called with, in order */
function spawned(): string[] {
  return spawnMock.mock.calls.map((call) => call[0] as string);
}

function unrefs(): number {
  return children.filter((child) => child.unref.mock.calls.length > 0).length;
}

async function openTerminal(dir: string): Promise<IPCResult<void>> {
  const handler = handlers.get(IPC_CHANNELS.SHELL_OPEN_TERMINAL);
  if (!handler) throw new Error('SHELL_OPEN_TERMINAL not registered');
  const pending = handler({}, dir) as Promise<IPCResult<void>>;
  // Past the emulators' own events, then past the grace period each one is watched for
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(2000);
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  platform.mac = false;
  platform.windows = false;
  wsl.info = null;
  outcomes.clear();
  children = [];
  spawnMock.mockImplementation((command: string) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    children.push(child);
    const outcome = outcomes.get(command) ?? 'stays';
    setTimeout(() => {
      if (outcome === 'missing') {
        child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }));
        return;
      }
      child.emit('spawn');
      if (outcome === 'fails') child.emit('exit', 1, null);
      if (outcome === 'late' || outcome === 'very-late') {
        setTimeout(() => child.emit('exit', 1, null), outcome === 'late' ? LATE_MS : VERY_LATE_MS);
      }
      if (outcome === 'closed') {
        // A window the user shut: the shell it ran died with it, on a signal rather than a code
        setTimeout(() => child.emit('exit', null, 'SIGHUP'), LATE_MS);
      }
      if (outcome === 'late-error' || outcome === 'very-late-error') {
        setTimeout(
          () => child.emit('error', new Error(`spawn ${command} EACCES`)),
          outcome === 'late-error' ? LATE_MS : VERY_LATE_MS
        );
      }
    }, 1);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SHELL_OPEN_TERMINAL on Linux', () => {
  it('tries the next emulator when one starts and then fails', async () => {
    // gnome-terminal is installed but cannot reach a display: it spawns and exits non-zero
    outcomes.set('gnome-terminal', 'fails');

    const result = await openTerminal(DIR);

    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal', 'konsole']);
    expect(spawnMock.mock.calls[1][1]).toEqual(['--workdir', DIR]);
  });

  it('reports the first emulator that stays up, without waiting for its window', async () => {
    const handler = handlers.get(IPC_CHANNELS.SHELL_OPEN_TERMINAL)!;
    const pending = handler({}, DIR) as Promise<IPCResult<void>>;
    await vi.advanceTimersByTimeAsync(10);
    // The window is still open, as it is until the user closes it
    await vi.advanceTimersByTimeAsync(2000);

    expect(await pending).toEqual({ success: true });
    expect(spawned()).toEqual(['gnome-terminal']);
    expect(unrefs()).toBe(1);
  });

  /**
   * These four used to assert that a failure reported within five seconds of the start sent the
   * walk on to the next candidate. They now assert the opposite, because the band that resume was
   * the only cover for turns out to be empty: the failures that leave the screen empty are
   * decided either in tens of milliseconds, inside the 400 ms grace period where the walk already
   * moves on by itself, or after GDBus's 25 s default timeout, far outside any five-second window.
   * What does land in that band is a user closing a window, which the resume answered by opening
   * another one - see the test below it.
   */
  it('leaves an emulator that gave up after it was reported as open alone, and logs it', async () => {
    // gnome-terminal's hand-off to its own server times out: it is still alive when the grace
    // period passes, so the handler has already answered, and only then does it exit non-zero
    outcomes.set('gnome-terminal', 'late');

    const result = await openTerminal(DIR);

    // The answer stands, since it was given before the failure showed, and the log carries the
    // failure with how long the emulator lasted, which is all that can honestly be said about it
    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal']);
    const logged = appLogMock.warn.mock.calls.flat().join(' ');
    expect(logged).toContain('gnome-terminal was reported as open');
    expect(logged).toMatch(/exited with code 1 after \d+ ms/);
  });

  it('logs a non-zero exit however long after the window was reported as open it comes', async () => {
    // The real slow failure: a hung D-Bus activation that GDBus gives up on around 25 s. It is
    // logged like any other, since this is the only trace such a failure ever leaves.
    outcomes.set('gnome-terminal', 'very-late');

    const result = await openTerminal(DIR);
    await vi.advanceTimersByTimeAsync(VERY_LATE_MS * 2);

    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal']);
    expect(appLogMock.warn.mock.calls.flat().join(' ')).toContain('gnome-terminal was reported as open');
  });

  it('gives a spawn failure reported after the grace period the same treatment', async () => {
    // The same lateness from the other direction: nothing exited, the spawn itself was reported
    // as failed, and only after the grace period had already answered. Left unhandled this is the
    // quietest failure there is - the user is told the terminal opened, no window appears, and
    // not even a line is logged - so it gets exactly what a late exit gets.
    outcomes.set('gnome-terminal', 'late-error');

    const result = await openTerminal(DIR);

    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal']);
    expect(appLogMock.warn.mock.calls.flat().join(' ')).toContain('gnome-terminal was reported as open');
  });

  it('logs a spawn failure reported long after the window was reported as open', async () => {
    outcomes.set('gnome-terminal', 'very-late-error');

    const result = await openTerminal(DIR);
    await vi.advanceTimersByTimeAsync(VERY_LATE_MS * 2);

    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal']);
    expect(appLogMock.warn.mock.calls.flat().join(' ')).toContain('gnome-terminal was reported as open');
  });

  it('starts no second terminal when the user closes the first one on a failed shell', async () => {
    // The window opened, the user shut it a second later, and the shell inside it died on a
    // signal: a non-zero exit as late as a real failure to open, and nothing here can tell the
    // two apart. A terminal appearing seconds after the user deliberately closed one is the worse
    // of the two mistakes, so no candidate behind this one is started.
    outcomes.set('gnome-terminal', 'closed');

    const result = await openTerminal(DIR);
    await vi.advanceTimersByTimeAsync(LATE_MS * 2);

    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal']);
    expect(appLogMock.warn.mock.calls.flat().join(' ')).toContain('exited on SIGHUP');
  });

  it('tries the next emulator when one is not installed', async () => {
    outcomes.set('gnome-terminal', 'missing');
    outcomes.set('konsole', 'missing');

    const result = await openTerminal(DIR);

    expect(result.success).toBe(true);
    expect(spawned()).toEqual(['gnome-terminal', 'konsole', 'xfce4-terminal']);
  });

  it('fails when every emulator is missing or gives up', async () => {
    for (const cmd of ['gnome-terminal', 'xfce4-terminal']) outcomes.set(cmd, 'fails');
    for (const cmd of ['konsole', 'xterm']) outcomes.set(cmd, 'missing');

    const result = await openTerminal(DIR);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No supported terminal emulator found');
    expect(spawned()).toEqual(['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']);
  });
});

describe('SHELL_OPEN_TERMINAL elsewhere', () => {
  it('opens Terminal.app on macOS', async () => {
    platform.mac = true;

    expect(await openTerminal(DIR)).toEqual({ success: true });
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual(['open', ['-a', 'Terminal', DIR]]);
  });

  it('opens a console inside the distribution when the tools run in WSL', async () => {
    platform.windows = true;
    wsl.info = { distro: 'Ubuntu' };

    expect(await openTerminal(DIR)).toEqual({ success: true });
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual([
      'C:\\Windows\\System32\\wsl.exe',
      ['-d', 'Ubuntu', '--cd', DIR]
    ]);
  });

  it('opens cmd.exe on Windows', async () => {
    platform.windows = true;

    expect(await openTerminal(DIR)).toEqual({ success: true });
    expect(spawnMock.mock.calls[0].slice(0, 2)).toEqual(['cmd.exe', ['/K', 'cd', '/d', DIR]]);
  });
});
