/**
 * Onboarding for the account an agent window runs on.
 *
 * Claude Code opens its onboarding and theme prompts instead of a session unless the global config
 * of the account it runs with says onboarding is done, and `claude auth login` or a sign-in read
 * from the keychain never writes that flag. Workbench sets it for the account before typing the
 * command - including for Claude Code's own default `~/.claude`, which it runs with
 * CLAUDE_CONFIG_DIR removed rather than set: there the flag belongs in `~/.claude.json`, one level
 * above the dir, which is exactly the file Claude Code reads while the variable is absent.
 *
 * These tests run against a temporary home, so the account configs they write are their own.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { TerminalProcess } from '../types';
import type * as pty from '@lydell/node-pty';

/** The home Claude Code resolves `~` against, swapped for a temporary one per test */
const home = vi.hoisted(() => ({ dir: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home.dir }, homedir: () => home.dir };
});

vi.mock('../../platform', () => ({
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => false),
  isLinux: vi.fn(() => true),
  isUnix: vi.fn(() => true),
  getCurrentOS: vi.fn(() => 'linux'),
}));

const mockGetClaudeCliInvocation = vi.fn(() => ({ command: 'claude', env: { PATH: '/usr/bin' } }));
const mockGetClaudeCliInvocationAsync = vi.fn(async () => ({ command: 'claude', env: { PATH: '/usr/bin' } }));
vi.mock('../../cli-utils', () => ({
  getClaudeCliInvocation: mockGetClaudeCliInvocation,
  getClaudeCliInvocationAsync: mockGetClaudeCliInvocationAsync,
}));

const mockGetProfile = vi.fn();
const mockMarkProfileUsed = vi.fn();
const profileManager = {
  getActiveProfile: vi.fn(),
  getProfile: mockGetProfile,
  getProfileToken: vi.fn(() => null),
  markProfileUsed: mockMarkProfileUsed,
};
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => profileManager,
  initializeClaudeProfileManager: async () => profileManager,
}));

const mockWriteToPty = vi.fn();
vi.mock('../pty-manager', () => ({ writeToPty: mockWriteToPty }));

vi.mock('../session-handler', () => ({
  persistSession: vi.fn(),
  persistSessionAsync: vi.fn(),
}));

const mockLastAgentSession = vi.fn(async () => undefined as unknown);
vi.mock('../../agent-session-store', () => ({
  recordAgentSessionAsync: vi.fn(),
  lastAgentSession: mockLastAgentSession,
  readAgentSessions: vi.fn(async () => []),
}));

const mockFindSessionTranscript = vi.fn(async (_id: string, _dirs: string[]) => null as unknown);
vi.mock('../../claude-code/session-spending', () => ({
  findSessionTranscript: mockFindSessionTranscript,
  latestTranscript: vi.fn(async () => null),
}));

// The accounts to search for a session: the work account and Claude Code's own default dir
vi.mock('../../claude-profile/profile-config-dirs', () => ({
  claudeConfigDirs: (extra: Array<string | undefined> = []) => {
    const dirs = [path.join(home.dir, '.claude-profiles', 'work'), path.join(home.dir, '.claude')];
    for (const dir of extra) if (dir && !dirs.includes(dir)) dirs.push(dir);
    return dirs;
  },
}));

vi.mock('../../settings-utils', () => ({
  readSettingsFileAsync: vi.fn(async () => undefined),
  readSettingsFile: vi.fn(() => undefined),
}));

const createMockPty = (): pty.IPty => ({
  pid: 1,
  cols: 80,
  rows: 24,
  process: 'bash',
  handleFlowControl: false,
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onExit: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  kill: vi.fn(),
  clear: vi.fn(),
});

const createMockTerminal = (overrides: Partial<TerminalProcess> = {}): TerminalProcess => ({
  id: 'term-1',
  pty: createMockPty(),
  outputBuffer: '',
  isCLIMode: false,
  title: 'Terminal 1',
  cwd: '/tmp/project',
  projectPath: '/tmp/project',
  shellKind: 'posix',
  ...overrides,
});

/** Claude Code's own default config dir, and the global config it reads for that dir */
let defaultDir: string;
let defaultGlobalConfig: string;
/** An account of Workbench's own, whose global config sits inside its config dir */
let workDir: string;

/** A global config without the onboarding flag, as a fresh machine or a keychain sign-in leaves it */
function writeGlobalConfig(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ installMethod: 'native' }));
}

const onboardingComplete = (file: string): unknown =>
  JSON.parse(readFileSync(file, 'utf-8')).hasCompletedOnboarding;

const writtenCommand = (): string => mockWriteToPty.mock.calls[0][1] as string;

/**
 * Any assignment of CLAUDE_CONFIG_DIR, whatever the shell syntax or the quoting around the value.
 *
 * A window on the default dir has to run with the variable absent, so what matters is that the
 * command assigns it nowhere - not that it assigns it to nothing in particular. Matching only the
 * part up to the `=` keeps the guard blind to the quoting, which is the one thing it must not
 * depend on: an earlier version excluded `"` from the value it looked for and so let
 * `CLAUDE_CONFIG_DIR="/home/me/.claude"` - precisely the assignment it exists to forbid - pass.
 * The forms the emitters really produce are all covered: a bare or single-quoted POSIX
 * assignment, cmd's `set "CLAUDE_CONFIG_DIR=..."`, and PowerShell's `$env:CLAUDE_CONFIG_DIR = ...`.
 */
const NAMES_THE_DEFAULT_DIR = /CLAUDE_CONFIG_DIR\s*=/;

beforeEach(() => {
  home.dir = mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
  defaultDir = path.join(home.dir, '.claude');
  defaultGlobalConfig = path.join(home.dir, '.claude.json');
  workDir = path.join(home.dir, '.claude-profiles', 'work');
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mockWriteToPty.mockClear();
  mockMarkProfileUsed.mockClear();
  mockLastAgentSession.mockReset();
  mockLastAgentSession.mockResolvedValue(undefined);
  mockFindSessionTranscript.mockReset();
  mockFindSessionTranscript.mockResolvedValue(null);
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe('an agent window started on an account', () => {
  /**
   * A detected account in the default dir: the window runs with CLAUDE_CONFIG_DIR removed, so the
   * config that decides whether it opens in the wizard is `~/.claude.json`.
   */
  it('marks onboarding complete in ~/.claude.json and still sets no CLAUDE_CONFIG_DIR', async () => {
    writeGlobalConfig(defaultGlobalConfig);
    mockGetProfile.mockReturnValue({
      id: 'prof-detected',
      name: 'Claude Code',
      isDefault: false,
      detected: true,
      configDir: defaultDir,
    });

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(createMockTerminal(), '/tmp/project', 'prof-detected', () => null);

    expect(onboardingComplete(defaultGlobalConfig)).toBe(true);
    // Never the config inside the dir: Claude Code reads that one only when the variable names it
    expect(existsSync(path.join(defaultDir, '.claude.json'))).toBe(false);
    expect(writtenCommand()).toContain('env -u CLAUDE_CONFIG_DIR ');
    expect(writtenCommand()).not.toMatch(NAMES_THE_DEFAULT_DIR);
    expect(mockMarkProfileUsed).toHaveBeenCalledWith('prof-detected');
  });

  it("marks onboarding complete in an account's own dir, which it runs with as before", async () => {
    const workGlobalConfig = path.join(workDir, '.claude.json');
    writeGlobalConfig(workGlobalConfig);
    writeGlobalConfig(defaultGlobalConfig);
    mockGetProfile.mockReturnValue({ id: 'work', name: 'Work', isDefault: false, configDir: workDir });

    const { invokeClaude } = await import('../cli-integration-handler');
    invokeClaude(createMockTerminal(), '/tmp/project', 'work', () => null);

    expect(onboardingComplete(workGlobalConfig)).toBe(true);
    // And nothing was written to the config of the account the window does not run on
    expect(onboardingComplete(defaultGlobalConfig)).toBeUndefined();
    expect(writtenCommand()).toContain(`CLAUDE_CONFIG_DIR='${workDir}'`);
  });

  it('marks onboarding complete for the default dir on the async path too', async () => {
    writeGlobalConfig(defaultGlobalConfig);
    mockGetProfile.mockReturnValue({
      id: 'prof-detected',
      name: 'Claude Code',
      isDefault: false,
      detected: true,
      configDir: defaultDir,
    });

    const { invokeCLIAsync } = await import('../cli-integration-handler');
    await invokeCLIAsync(createMockTerminal(), '/tmp/project', 'prof-detected', () => null, false);

    expect(onboardingComplete(defaultGlobalConfig)).toBe(true);
    expect(writtenCommand()).toContain('env -u CLAUDE_CONFIG_DIR ');
    expect(writtenCommand()).not.toMatch(NAMES_THE_DEFAULT_DIR);
  });
});

/**
 * A resumed session runs on the account that holds its transcript, which can be the default dir
 * whichever account the window itself was started on - so its config needs the flag just as much.
 */
describe('an agent window picking a session up again', () => {
  const SESSION = '0b7c6c1e-1234-4abc-9def-001122334455';

  it("marks onboarding complete for a session resumed in Claude Code's default dir", async () => {
    writeGlobalConfig(defaultGlobalConfig);
    mockGetProfile.mockReturnValue({ id: 'work', name: 'Work', isDefault: false, configDir: workDir });

    const { invokeCLIAsync } = await import('../cli-integration-handler');
    await invokeCLIAsync(createMockTerminal(), '/tmp/project', 'work', () => null, false, {
      resumeSessionId: SESSION,
      configDir: defaultDir,
    });

    expect(onboardingComplete(defaultGlobalConfig)).toBe(true);
    expect(writtenCommand()).toContain(`env -u CLAUDE_CONFIG_DIR 'claude' --resume ${SESSION}`);
  });

  it("marks onboarding complete when a restored window's own session is in the default dir", async () => {
    writeGlobalConfig(defaultGlobalConfig);
    mockLastAgentSession.mockResolvedValue({
      sessionId: SESSION,
      configDir: workDir,
      startedAt: '2026-10-21T09:00:00.000Z',
      cwd: '/tmp/project',
    });
    // An account swap left the conversation under the default dir
    mockFindSessionTranscript.mockImplementation(async (_id: string, dirs: string[]) =>
      dirs[0] === defaultDir ? { file: '/t.jsonl', size: 10, modifiedMs: 1 } : null
    );

    const { resumeClaudeAsync } = await import('../cli-integration-handler');
    await resumeClaudeAsync(createMockTerminal(), () => null);

    expect(onboardingComplete(defaultGlobalConfig)).toBe(true);
    expect(writtenCommand()).toContain(`env -u CLAUDE_CONFIG_DIR 'claude' --resume ${SESSION}`);
  });
});
