/**
 * Finding every Claude Code session that ran in a project, whichever account wrote it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { findProjectSessions } from '../claude-code/project-sessions';

vi.mock('../claude-profile-manager', () => ({ getClaudeProfileManager: () => ({ getProfileConfigDirs: () => [] }) }));

describe('finding a project\'s sessions', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'project-sessions-'));
    project = path.join(root, 'project');
    mkdirSync(project, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A transcript Claude Code wrote for a session that ran in `cwd` */
  const givenSession = (configDir: string, sessionId: string, cwd: string, writtenMs = Date.now()): string => {
    // Claude Code names the folder after the directory with every character that is not a letter
    // or a digit replaced by a dash, the drive letter included (`/home/me/.config` becomes
    // `-home-me--config`). Anything narrower matches nothing at all on a host whose temporary
    // directory holds a character this rule replaces and that one keeps.
    const folder = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(root, configDir, 'projects', folder);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, sessionId, timestamp: '2026-10-20T09:00:00.000Z' })}\n`);
    utimesSync(file, new Date(writtenMs), new Date(writtenMs));
    return file;
  };

  const configDirs = (...dirs: string[]) => dirs.map((dir) => path.join(root, dir));
  const ids = async (options = {}) =>
    (await findProjectSessions(project, configDirs('.claude', '.claude-profiles/work'), options)).map((s) => s.sessionId);

  it('finds the sessions of the project and of directories inside it', async () => {
    givenSession('.claude', 'in-project', project);
    givenSession('.claude', 'in-subdirectory', path.join(project, 'src'));

    expect((await ids()).sort()).toEqual(['in-project', 'in-subdirectory']);
  });

  it('finds sessions under every account', async () => {
    givenSession('.claude', 'default-account', project);
    givenSession('.claude-profiles/work', 'other-account', project);

    expect((await ids()).sort()).toEqual(['default-account', 'other-account']);
  });

  it('leaves out sessions of another project, even one whose name starts the same', async () => {
    givenSession('.claude', 'elsewhere', path.join(root, 'other'));
    givenSession('.claude', 'lookalike', `${project}-old`);

    expect(await ids()).toEqual([]);
  });

  it('leaves out the sessions of task worktrees and of the tasks themselves', async () => {
    givenSession('.claude', 'window', project);
    givenSession('.claude', 'task-run', path.join(project, '.workbench', 'worktrees', 'tasks', '001-one'));
    givenSession('.claude', 'task-without-worktree', project);

    const found = await ids({
      skip: new Set(['task-without-worktree']),
      skipUnder: [path.join(project, '.workbench', 'worktrees')],
    });

    expect(found).toEqual(['window']);
  });

  it('reports the newest copy of a session a profile swap moved', async () => {
    givenSession('.claude', 'moved', project, Date.parse('2026-10-19T09:00:00.000Z'));
    givenSession('.claude-profiles/work', 'moved', project, Date.parse('2026-10-21T09:00:00.000Z'));

    const found = await findProjectSessions(project, configDirs('.claude', '.claude-profiles/work'));

    expect(found).toHaveLength(1);
    expect(found[0].configDir).toBe(path.join(root, '.claude-profiles/work'));
  });

  it('reports the sessions written to most recently first', async () => {
    givenSession('.claude', 'older', project, Date.parse('2026-10-19T09:00:00.000Z'));
    givenSession('.claude', 'newer', project, Date.parse('2026-10-21T09:00:00.000Z'));

    expect(await ids()).toEqual(['newer', 'older']);
  });

  it('leaves out a transcript that says nothing about where it ran, and an empty one', async () => {
    const empty = givenSession('.claude', 'empty', project);
    writeFileSync(empty, '');
    const dir = path.dirname(empty);
    writeFileSync(path.join(dir, 'no-cwd.jsonl'), '{"type":"user","timestamp":"2026-10-20T09:00:00.000Z"}\n');

    expect(await ids()).toEqual([]);
  });

  it('finds nothing when no account has sessions', async () => {
    expect(await ids()).toEqual([]);
  });
});
