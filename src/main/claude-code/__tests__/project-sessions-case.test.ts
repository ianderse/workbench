/**
 * Finding a project's sessions when Claude Code named the folder in another case.
 *
 * Claude Code names the folder under `<config dir>/projects` after the directory as it was typed,
 * so the same project reached as `c:\Users\me\app` once and `C:\Users\me\app` another time is kept
 * under two folder names that Windows itself considers one folder. The folder name is only a gate
 * on the way to the transcript, but a gate that rejects such a folder costs the session its
 * spending in Metrics and its turns in the memory backfill all the same.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// Whether the app runs on Windows, whose filesystem reaches one folder under either case
const windowsRef = vi.hoisted(() => ({ on: true }));
vi.mock('../../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform')>()),
  isWindows: () => windowsRef.on,
}));
// Claude Code runs natively here: the WSL case has its own file
vi.mock('../../platform/shell-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../platform/shell-runtime')>()),
  getWslInfo: () => null,
  isWslRuntime: () => false,
  toRuntimePath: (p: string) => p,
  toHostPath: (p: string) => p,
}));
vi.mock('../../claude-profile-manager', () => ({
  getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [] }),
}));

import { findProjectSessions } from '../project-sessions';

let root: string;

beforeEach(() => {
  windowsRef.on = true;
  root = mkdtempSync(path.join(os.tmpdir(), 'wb-sessions-case-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A transcript Claude Code wrote for a session that ran in `cwd`, under the name it gives it.
 *
 * `folderFor` separates the two: the folder is named after it instead of after `cwd`, which is
 * what it takes to ask the folder-name gate about a session the transcript's own `cwd` would be
 * happy to claim, and so to see the gate decide rather than the `cwd` comparison behind it.
 */
const givenSession = (sessionId: string, cwd: string, folderFor: string = cwd): void => {
  const dir = path.join(root, '.claude', 'projects', folderFor.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, sessionId, timestamp: '2026-10-20T09:00:00.000Z' })}\n`
  );
};

const ids = async (project: string) =>
  (await findProjectSessions(project, [path.join(root, '.claude')])).map((s) => s.sessionId).sort();

describe("a project's sessions found under a folder spelled in another case", () => {
  const project = 'C:\\Users\\me\\app';

  it('finds a session whose folder differs from the project only in case', async () => {
    givenSession('lower-drive', 'c:\\Users\\me\\app');
    givenSession('other-case-inside', 'c:\\users\\me\\app\\src');

    expect(await ids(project)).toEqual(['lower-drive', 'other-case-inside']);
  });

  it('still leaves out another project whose name starts the same, in any case', async () => {
    givenSession('lookalike', 'c:\\Users\\me\\app-old');
    givenSession('elsewhere', 'C:\\Users\\me\\other');

    expect(await ids(project)).toEqual([]);
  });

  it('matches the folder as it is where two directories can differ in case alone', async () => {
    windowsRef.on = false;
    const posixProject = path.join(root, 'app');

    // The two folders have to exist side by side for the gate to be asked about the second one,
    // so their names differ by more than case. Two names that differed only in case would be one
    // folder on macOS and Windows, where this suite also runs, and the second session would land
    // in the first folder - leaving the gate untested on two platforms out of three.
    givenSession('inside-the-project', path.join(posixProject, 'src'));
    // A folder named for `<root>/App`, which on POSIX is a directory of its own. Its transcript
    // names the project itself as the cwd, so `belongsToProject()` would claim the session: the
    // folder name differing in case is the only thing that can still turn it away, which is the
    // rule under test. Fold case here and this session is counted against the wrong project.
    givenSession('other-directory', posixProject, path.join(root, 'App'));

    expect(await ids(posixProject)).toEqual(['inside-the-project']);
  });
});
