/**
 * Session transcripts of Claude Code inside WSL: the project folder is named after the Linux path
 * Claude Code sees (/mnt/c/... for a Windows project), under the config dir in the Linux home.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const wslRef = vi.hoisted(() => ({ on: true }));
vi.mock('../../platform/shell-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/shell-runtime')>();
  const { windowsToWsl } = await import('../../platform/wsl-paths');
  const info = { distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/', loginPath: '/usr/bin', tools: {} };
  return {
    ...actual,
    isWslRuntime: () => wslRef.on,
    getWslInfo: () => (wslRef.on ? info : null),
    toRuntimePath: (p: string) => (wslRef.on ? windowsToWsl(p, info) ?? p : p),
  };
});

import { getSessionFilePath } from '../session-utils';

beforeEach(() => {
  wslRef.on = true;
});

describe('session files in WSL', () => {
  it('names the project folder after the Linux path, under the Linux home', () => {
    const expected = '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects\\-mnt-c-Users-me-app\\abc.jsonl';
    expect(getSessionFilePath('~/.claude', 'C:\\Users\\me\\app', 'abc')).toBe(expected);
    // A cwd that already is a Linux path gives the same folder
    expect(getSessionFilePath('~/.claude', '/mnt/c/Users/me/app', 'abc')).toBe(expected);
    expect(getSessionFilePath('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-2', '/home/me/src/app', 'abc'))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-2\\projects\\-home-me-src-app\\abc.jsonl');
  });

  it('keeps the native folder name natively', () => {
    wslRef.on = false;
    expect(getSessionFilePath('/home/me/.claude', '/Users/me/app', 'abc')).toBe('/home/me/.claude/projects/-Users-me-app/abc.jsonl');
  });
});
