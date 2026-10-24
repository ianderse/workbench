/**
 * Attributing transcripts to a project when Claude Code runs inside WSL.
 *
 * The backfill reads the transcripts of the project it is building memories for. Inside WSL every
 * transcript records a Linux cwd (`/mnt/c/Users/me/app`) while the project is stored as a Windows
 * path, so without translating one side the backfill finds nothing and the project starts empty.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const wslRef = vi.hoisted(() => ({ on: true }));
vi.mock('../../platform/shell-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platform/shell-runtime')>();
  const { windowsToWsl, wslToWindows } = await import('../../platform/wsl-paths');
  const info = { distro: 'Ubuntu', home: '/home/me', mountRoot: '/mnt/', loginPath: '/usr/bin', tools: {} };
  return {
    ...actual,
    isWslRuntime: () => wslRef.on,
    getWslInfo: () => (wslRef.on ? info : null),
    toRuntimePath: (p: string) => (wslRef.on ? windowsToWsl(p, info) ?? p : p),
    toHostPath: (p: string) => (wslRef.on ? wslToWindows(p, info) : p),
  };
});

// Whether the app itself runs on Windows, which these tests also need without WSL: the host of a
// WSL runtime is always Windows, but a Windows host does not have to run its tools in WSL
const windowsRef = vi.hoisted(() => ({ on: false }));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => windowsRef.on,
}));

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The real list resolves its dirs as Windows paths in WSL mode, which a temp dir here is not
const configDirRef = vi.hoisted(() => ({ path: '' }));
vi.mock('../../claude-profile/profile-config-dirs', () => ({
  claudeConfigDirs: () => [configDirRef.path],
}));

import { belongsToProject, findProjectTranscripts } from '../transcripts';

/** The project as Workbench stores it, and as Claude Code inside the distribution sees it */
const project = 'C:\\Users\\me\\app';
const projectInWsl = '/mnt/c/Users/me/app';

let tmp: string;

beforeEach(async () => {
  wslRef.on = true;
  windowsRef.on = false;
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wb-transcripts-wsl-'));
  configDirRef.path = path.join(tmp, 'claude');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const givenTranscript = async (name: string, cwdInWsl: string): Promise<string> => {
  const dir = path.join(configDirRef.path, 'projects', cwdInWsl.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, `${JSON.stringify({ type: 'user', cwd: cwdInWsl, message: { role: 'user', content: 'hi' } })}\n`);
  return file;
};

describe('belongsToProject in WSL', () => {
  it('matches a Linux cwd against the Windows path the project is stored as', () => {
    expect(belongsToProject(projectInWsl, project)).toBe(true);
    expect(belongsToProject(`${projectInWsl}/src`, project)).toBe(true);
    expect(belongsToProject(`${projectInWsl}/.workbench/worktrees/tasks/001`, project)).toBe(true);
  });

  it('still rejects a sibling whose name only starts the same, and a parent', () => {
    expect(belongsToProject('/mnt/c/Users/me/app-old', project)).toBe(false);
    expect(belongsToProject('/mnt/c/Users/me', project)).toBe(false);
  });

  it("matches the distribution's own files against their UNC path", () => {
    expect(belongsToProject('/home/me/src/app', '\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app')).toBe(true);
    expect(belongsToProject('/home/me/src/other', '\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app')).toBe(false);
  });

  it('matches a project added under the older UNC alias against the newer spelling', () => {
    // Explorer shows `\\\\wsl$\\...`, so that is the spelling a user pastes when adding a project that
    // lives in the distribution, while `toHostPath()` renders every session's cwd as
    // `\\\\wsl.localhost\\...`. Reading those as two folders would leave that project matching no
    // session at all: no spending in Metrics, and nothing for the backfill to learn from.
    expect(belongsToProject('/home/me/src/app', '\\\\wsl$\\Ubuntu\\home\\me\\src\\app')).toBe(true);
    expect(belongsToProject('/home/me/src/app/packages/ui', '\\\\wsl$\\Ubuntu\\home\\me\\src\\app')).toBe(true);
    // And the other way round, for a project added from the app's own path handling
    expect(belongsToProject('/home/me/src/app', '\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app')).toBe(true);
    // The alias must not start claiming siblings or parents either
    expect(belongsToProject('/home/me/src/app-old', '\\\\wsl$\\Ubuntu\\home\\me\\src\\app')).toBe(false);
    expect(belongsToProject('/home/me/src', '\\\\wsl$\\Ubuntu\\home\\me\\src\\app')).toBe(false);
    // Another distribution's files are its own
    expect(belongsToProject('/home/me/src/app', '\\\\wsl$\\Debian\\home\\me\\src\\app')).toBe(false);
  });

  it('matches a cwd that differs from the project only in case, as Windows itself would', () => {
    // Windows reaches the same folder whatever the case, so a transcript recorded this way is
    // this project's; dropping it would lose the session's spending and its turns in silence
    expect(belongsToProject('/mnt/c/users/ME/app', project)).toBe(true);
    expect(belongsToProject(`${projectInWsl}/SRC`, project)).toBe(true);
    expect(belongsToProject(projectInWsl, 'c:\\Users\\Me\\APP')).toBe(true);
    expect(belongsToProject('/home/ME/src/app', '\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app')).toBe(true);
    // Case folding must not start claiming siblings or parents
    expect(belongsToProject('/mnt/c/Users/me/APP-OLD', project)).toBe(false);
    expect(belongsToProject('/mnt/C/USERS/ME', project)).toBe(false);
  });
});

describe('belongsToProject on Windows without WSL', () => {
  it('matches two spellings of the same folder', () => {
    wslRef.on = false;
    windowsRef.on = true;

    expect(belongsToProject('c:\\users\\me\\app', project)).toBe(true);
    expect(belongsToProject('C:\\Users\\me\\app\\SRC', project)).toBe(true);
    expect(belongsToProject('C:\\Users\\me\\app-old', project)).toBe(false);
    // A project on a Windows host can still be added as a path into a distribution, from Explorer
    // or by hand, and the two prefixes are one folder there too
    expect(belongsToProject('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', '\\\\wsl$\\Ubuntu\\home\\me\\app')).toBe(true);
    expect(belongsToProject('\\\\wsl$\\Ubuntu\\home\\me\\app\\src', '\\\\wsl.localhost\\Ubuntu\\home\\me\\app')).toBe(true);
    expect(belongsToProject('\\\\wsl$\\Ubuntu\\home\\me\\app-old', '\\\\wsl.localhost\\Ubuntu\\home\\me\\app')).toBe(false);
  });
});

describe('belongsToProject off Windows', () => {
  it('keeps comparing case-sensitively, since two folders there can differ in case alone', () => {
    wslRef.on = false;
    windowsRef.on = false;

    expect(belongsToProject('/work/my-repo', '/work/my-repo')).toBe(true);
    expect(belongsToProject('/work/My-Repo', '/work/my-repo')).toBe(false);
    expect(belongsToProject('/work/my-repo/SRC', '/work/my-repo/src')).toBe(false);
  });
});

describe('findProjectTranscripts in WSL', () => {
  it('finds the transcripts the distribution wrote for the project', async () => {
    const mine = await givenTranscript('a.jsonl', projectInWsl);
    const inside = await givenTranscript('b.jsonl', `${projectInWsl}/src`);
    await givenTranscript('c.jsonl', '/mnt/c/Users/me/other');

    const found = await findProjectTranscripts(project);

    expect(found.map((t) => t.file).sort()).toEqual([mine, inside].sort());
  });
});
