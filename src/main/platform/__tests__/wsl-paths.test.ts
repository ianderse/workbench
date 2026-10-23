/**
 * Windows <-> WSL path translation and Claude Code's project folder naming
 */
import { describe, it, expect } from 'vitest';
import {
  isWslUncPath,
  normalizeMountRoot,
  windowsToWsl,
  wslToWindows
} from '../wsl-paths';
import { claudeProjectSlug } from '../claude-home';

const ubuntu = { distro: 'Ubuntu' };

describe('windowsToWsl', () => {
  it('maps drive paths under the mount root with a lower-case drive letter', () => {
    expect(windowsToWsl('C:\\Users\\me\\repo', ubuntu)).toBe('/mnt/c/Users/me/repo');
    expect(windowsToWsl('D:/work/app', ubuntu)).toBe('/mnt/d/work/app');
    expect(windowsToWsl('C:\\', ubuntu)).toBe('/mnt/c');
    expect(windowsToWsl('C:', ubuntu)).toBe('/mnt/c');
    expect(windowsToWsl('C:\\a\\b\\', ubuntu)).toBe('/mnt/c/a/b');
  });

  it('keeps spaces', () => {
    expect(windowsToWsl('C:\\Program Files\\My App\\x.txt', ubuntu)).toBe('/mnt/c/Program Files/My App/x.txt');
  });

  it('honors a custom mount root', () => {
    expect(windowsToWsl('C:\\a', { distro: 'Ubuntu', mountRoot: '/' })).toBe('/c/a');
    expect(windowsToWsl('C:\\a', { distro: 'Ubuntu', mountRoot: '/win' })).toBe('/win/c/a');
    expect(windowsToWsl('C:\\a', { distro: 'Ubuntu', mountRoot: '/win/' })).toBe('/win/c/a');
  });

  it("maps the distribution's own UNC paths (wsl.localhost and wsl$)", () => {
    expect(windowsToWsl('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', ubuntu)).toBe('/home/me/repo');
    expect(windowsToWsl('\\\\wsl$\\Ubuntu\\home\\me', ubuntu)).toBe('/home/me');
    expect(windowsToWsl('\\\\wsl.localhost\\ubuntu\\', ubuntu)).toBe('/');
    expect(windowsToWsl('\\\\wsl.localhost\\Ubuntu', ubuntu)).toBe('/');
    expect(windowsToWsl('//wsl.localhost/Ubuntu/etc/hosts', ubuntu)).toBe('/etc/hosts');
  });

  it('rejects another distribution and network shares', () => {
    expect(windowsToWsl('\\\\wsl.localhost\\Debian\\home\\me', ubuntu)).toBeNull();
    expect(windowsToWsl('\\\\wsl$\\Debian\\x', ubuntu)).toBeNull();
    expect(windowsToWsl('\\\\server\\share\\x', ubuntu)).toBeNull();
  });

  it('leaves POSIX paths alone and gives relative paths forward slashes', () => {
    expect(windowsToWsl('/home/me', ubuntu)).toBe('/home/me');
    expect(windowsToWsl('src\\main\\index.ts', ubuntu)).toBe('src/main/index.ts');
  });
});

describe('wslToWindows', () => {
  it('maps the mount root back to drives', () => {
    expect(wslToWindows('/mnt/c/Users/me/repo', ubuntu)).toBe('C:\\Users\\me\\repo');
    expect(wslToWindows('/mnt/d', ubuntu)).toBe('D:\\');
    expect(wslToWindows('/mnt/c/', ubuntu)).toBe('C:\\');
    expect(wslToWindows('/c/a', { distro: 'Ubuntu', mountRoot: '/' })).toBe('C:\\a');
  });

  it("maps other paths to the distribution's UNC share", () => {
    expect(wslToWindows('/home/me/repo', ubuntu)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    expect(wslToWindows('/', ubuntu)).toBe('\\\\wsl.localhost\\Ubuntu');
    // A folder under the mount root that isn't a drive letter
    expect(wslToWindows('/mnt/wsl/x', ubuntu)).toBe('\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\x');
  });

  it('gives relative paths backslashes', () => {
    expect(wslToWindows('src/main', ubuntu)).toBe('src\\main');
  });
});

describe('round trips', () => {
  const cases = ['C:\\Users\\me\\My Repo\\file.ts', 'D:\\a', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'];
  for (const original of cases) {
    it(`keeps ${original}`, () => {
      const runtime = windowsToWsl(original, ubuntu);
      expect(runtime).not.toBeNull();
      expect(wslToWindows(runtime as string, ubuntu)).toBe(original);
    });
  }

  it('keeps Linux paths', () => {
    const host = wslToWindows('/home/me/a b', ubuntu);
    expect(windowsToWsl(host, ubuntu)).toBe('/home/me/a b');
  });
});

describe('helpers', () => {
  it('recognizes WSL UNC paths', () => {
    expect(isWslUncPath('\\\\wsl.localhost\\Ubuntu\\home')).toBe(true);
    expect(isWslUncPath('\\\\wsl$\\Ubuntu')).toBe(true);
    expect(isWslUncPath('\\\\WSL.LOCALHOST\\Ubuntu\\x')).toBe(true);
    expect(isWslUncPath('\\\\server\\share')).toBe(false);
    expect(isWslUncPath('C:\\wsl.localhost')).toBe(false);
  });

  it('normalizes the mount root', () => {
    expect(normalizeMountRoot(undefined)).toBe('/mnt/');
    expect(normalizeMountRoot('/mnt')).toBe('/mnt/');
    expect(normalizeMountRoot('/')).toBe('/');
  });

  it('names Claude Code project folders like Claude Code does', () => {
    expect(claudeProjectSlug('/home/me/repo')).toBe('-home-me-repo');
    expect(claudeProjectSlug('C:\\Users\\me\\repo')).toBe('C:-Users-me-repo');
  });
});
