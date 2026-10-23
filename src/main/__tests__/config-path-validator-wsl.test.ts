/**
 * isValidConfigDir while the app runs its tools in WSL: Claude Code's config dirs are in the
 * distribution's Linux home (\\wsl.localhost\<distro>\home\<user>), which is a valid place; the
 * rest of the distribution and other homes are not.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const wslRef = vi.hoisted(() => ({ on: true }));
vi.mock('../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/shell-runtime')>()),
  isWslRuntime: () => wslRef.on,
  getWslInfo: () => (wslRef.on ? { distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/', loginPath: '/usr/bin', tools: {} } : null),
}));

import { isValidConfigDir } from '../utils/config-path-validator';

const HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me';

describe('isValidConfigDir in WSL', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    wslRef.on = true;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  test("accepts the Linux home and the dirs in it, also with ~", () => {
    expect(isValidConfigDir(HOME)).toBe(true);
    expect(isValidConfigDir(`${HOME}\\.claude`)).toBe(true);
    expect(isValidConfigDir(`${HOME}\\.claude-work`)).toBe(true);
    expect(isValidConfigDir(`${HOME}\\.claude-profiles\\primary`)).toBe(true);
    expect(isValidConfigDir('\\\\wsl$\\Ubuntu\\home\\me\\.claude-2')).toBe(true);
    expect(isValidConfigDir('~/.claude-2')).toBe(true);
    expect(isValidConfigDir('~')).toBe(true);
  });

  test('rejects the rest of the distribution, other homes and traversal', () => {
    expect(isValidConfigDir('\\\\wsl.localhost\\Ubuntu\\etc')).toBe(false);
    expect(isValidConfigDir('\\\\wsl.localhost\\Ubuntu\\home\\me-other\\.claude')).toBe(false);
    expect(isValidConfigDir('\\\\wsl.localhost\\Ubuntu\\home\\other\\.claude')).toBe(false);
    expect(isValidConfigDir('\\\\wsl.localhost\\Debian\\home\\me\\.claude')).toBe(false);
    expect(isValidConfigDir(`${HOME}\\..\\other`)).toBe(false);
    expect(isValidConfigDir('~/../other')).toBe(false);
  });

  // UNC paths exist only on Windows; elsewhere the string is a relative path under the cwd
  test.runIf(process.platform === 'win32')("natively the Linux home isn't a valid place", () => {
    wslRef.on = false;
    expect(isValidConfigDir(`${HOME}\\.claude`)).toBe(false);
  });
});
