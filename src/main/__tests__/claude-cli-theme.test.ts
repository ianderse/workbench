import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const mocks = vi.hoisted(() => ({
  /** App settings on disk; undefined stands for "no settings file" */
  settings: undefined as Record<string, unknown> | undefined,
  systemDark: false,
  isWindows: false,
  /** Paths that exist on disk */
  existing: new Set<string>(),
  writeFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/data' },
  nativeTheme: {
    get shouldUseDarkColors() {
      return mocks.systemDark;
    },
  },
}));
vi.mock('fs', () => ({
  existsSync: (path: string) => mocks.existing.has(String(path)),
  writeFileSync: (...args: unknown[]) => mocks.writeFileSync(...args),
}));
vi.mock('../platform', () => ({ isWindows: () => mocks.isWindows }));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => mocks.settings }));
vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { claudeThemeFlag, writeClaudeThemeSettings } from '../claude-cli-theme';

// Built with path.join, like the code under test: on Windows these are \data\claude-theme-*.json,
// and comparing them against POSIX spellings would fail there
const LIGHT_FILE = path.join('/data', 'claude-theme-light.json');
const DARK_FILE = path.join('/data', 'claude-theme-dark.json');

beforeEach(() => {
  mocks.settings = undefined;
  mocks.systemDark = false;
  mocks.isWindows = false;
  mocks.existing = new Set([LIGHT_FILE, DARK_FILE]);
  mocks.writeFileSync.mockClear();
});

describe('writeClaudeThemeSettings', () => {
  it('writes a settings file for each theme', () => {
    writeClaudeThemeSettings();

    const written = mocks.writeFileSync.mock.calls.map(([file, contents]) => [file, contents]);
    expect(written.map(([file]) => file)).toEqual([DARK_FILE, LIGHT_FILE]);
    expect(JSON.parse(String(written[0][1]))).toEqual({ theme: 'dark' });
    expect(JSON.parse(String(written[1][1]))).toEqual({ theme: 'light' });
  });

  it('keeps going when a file cannot be written', () => {
    mocks.writeFileSync.mockImplementationOnce(() => {
      throw new Error('read-only');
    });

    expect(() => writeClaudeThemeSettings()).not.toThrow();
    expect(mocks.writeFileSync).toHaveBeenCalledTimes(2);
  });
});

describe('claudeThemeFlag', () => {
  it('hands Claude Code the light theme in light mode', () => {
    mocks.settings = { theme: 'light' };
    expect(claudeThemeFlag()).toBe(` --settings '${LIGHT_FILE}'`);
  });

  it('hands Claude Code the dark theme in dark mode', () => {
    mocks.settings = { theme: 'dark' };
    expect(claudeThemeFlag()).toBe(` --settings '${DARK_FILE}'`);
  });

  it('follows the OS when the app theme is "system"', () => {
    mocks.settings = { theme: 'system' };
    expect(claudeThemeFlag()).toBe(` --settings '${LIGHT_FILE}'`);

    mocks.systemDark = true;
    expect(claudeThemeFlag()).toBe(` --settings '${DARK_FILE}'`);
  });

  it('follows the OS (the "system" default) when there are no settings yet', () => {
    expect(claudeThemeFlag()).toBe(` --settings '${LIGHT_FILE}'`);

    mocks.systemDark = true;
    expect(claudeThemeFlag()).toBe(` --settings '${DARK_FILE}'`);
  });

  it('quotes the path for cmd.exe on Windows', () => {
    mocks.isWindows = true;
    mocks.settings = { theme: 'light' };
    expect(claudeThemeFlag()).toBe(` --settings "${LIGHT_FILE}"`);
  });

  it('leaves the session on the user’s own theme when the file is missing', () => {
    mocks.existing = new Set();
    mocks.settings = { theme: 'light' };
    expect(claudeThemeFlag()).toBe('');
  });
});
