/**
 * Finding a project's sessions when Claude Code runs inside WSL.
 *
 * The project is stored as a Windows path, while Claude Code names its folders after the Linux path
 * it sees there and records that same Linux path as each session's `cwd`. Both ends have to be
 * brought into one namespace or Metrics reports a project with no sessions at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [] }),
}));

import { findProjectSessions } from '../project-sessions';

/** The project as Workbench stores it, and as Claude Code inside the distribution sees it */
const project = 'C:\\Users\\me\\app';
const projectInWsl = '/mnt/c/Users/me/app';

let root: string;

beforeEach(() => {
  wslRef.on = true;
  root = mkdtempSync(path.join(os.tmpdir(), 'wb-sessions-wsl-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A transcript as Claude Code inside WSL writes it: Linux folder name and Linux `cwd` */
const givenSession = (sessionId: string, cwdInWsl: string): void => {
  const folder = cwdInWsl.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(root, '.claude', 'projects', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd: cwdInWsl, sessionId, timestamp: '2026-10-20T09:00:00.000Z' })}\n`
  );
};

const ids = async (options = {}) =>
  (await findProjectSessions(project, [path.join(root, '.claude')], options)).map((s) => s.sessionId).sort();

describe("a project's sessions in WSL", () => {
  it('finds the sessions of the Linux path behind the stored Windows path', async () => {
    givenSession('in-project', projectInWsl);
    givenSession('in-subdirectory', `${projectInWsl}/src`);
    givenSession('elsewhere', '/mnt/c/Users/me/other');

    expect(await ids()).toEqual(['in-project', 'in-subdirectory']);
  });

  it('leaves out a directory counted elsewhere, named as the Windows path Workbench stores', async () => {
    givenSession('window', projectInWsl);
    givenSession('task-run', `${projectInWsl}/.workbench/worktrees/tasks/001-one`);

    expect(await ids({ skipUnder: [`${project}\\.workbench\\worktrees`] })).toEqual(['window']);
  });

  it('finds a session whose folder differs only in case, as the Windows disk behind it does', async () => {
    // `/mnt/c` is the same Windows disk, which reaches one folder under either case, so Claude Code
    // writes `-mnt-c-users-me-app` for a session the user started as `/mnt/c/users/me/app`
    givenSession('other-case', '/mnt/c/users/me/app');

    expect(await ids()).toEqual(['other-case']);
  });

  it('reports the directory each session ran in as the transcript recorded it', async () => {
    givenSession('in-project', projectInWsl);

    const found = await findProjectSessions(project, [path.join(root, '.claude')]);

    expect(found).toHaveLength(1);
    expect(found[0].cwd).toBe(projectInWsl);
  });
});
