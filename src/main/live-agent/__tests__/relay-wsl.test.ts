/**
 * The relay with Claude Code inside WSL: its sessions live in project dirs named after the Linux
 * path and record Linux working directories
 */
import { describe, expect, it } from 'vitest';
import { projectDirNames, sessionHostDir } from '../relay/relay';

const wsl = { distro: 'Ubuntu', mountRoot: '/mnt/' };

describe('relay paths with Claude Code in WSL', () => {
  it("also looks for a directory's sessions under its Linux name", () => {
    expect(projectDirNames(['C:\\Users\\me\\my_proj'], wsl)).toEqual(['C--Users-me-my-proj', '-mnt-c-Users-me-my-proj']);
    expect(projectDirNames(['\\\\wsl.localhost\\Ubuntu\\home\\me\\proj'], wsl)).toEqual(['--wsl-localhost-Ubuntu-home-me-proj', '-home-me-proj']);
  });

  it('honors the mount root', () => {
    expect(projectDirNames(['D:\\work'], { distro: 'Ubuntu', mountRoot: '/win/' })).toEqual(['D--work', '-win-d-work']);
  });

  it('keeps the names as they are natively', () => {
    expect(projectDirNames(['/home/me/proj', '/home/me/proj'], null)).toEqual(['-home-me-proj']);
    expect(projectDirNames(['C:\\Users\\me\\proj'], null)).toEqual(['C--Users-me-proj']);
  });

  it("maps a session's Linux working directory to the host path", () => {
    expect(sessionHostDir('/mnt/c/Users/me/proj', wsl)).toBe('C:\\Users\\me\\proj');
    expect(sessionHostDir('/home/me/proj', wsl)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj');
    expect(sessionHostDir('C:\\Users\\me\\proj', wsl)).toBe('C:\\Users\\me\\proj');
    expect(sessionHostDir('/home/me/proj', null)).toBe('/home/me/proj');
  });
});
