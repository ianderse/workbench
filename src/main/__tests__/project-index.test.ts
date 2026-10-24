/**
 * The project index is the project's CLAUDE.md: Use CLAUDE.md is on while the file is there.
 * Switching it off sets the file aside instead of deleting it (it is as often hand-written as
 * generated, and may never have been committed), and switching it back on restores that file
 * rather than writing a new one with `/init`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const runClaudeTextMock = vi.fn();
vi.mock('../claude-code/run-text', () => ({
  READ_ONLY_TOOLS: [],
  runClaudeText: (...args: unknown[]) => runClaudeTextMock(...args),
}));
vi.mock('../settings-utils', () => ({ readSettingsFile: () => ({}) }));

/**
 * Lets a test make one operation fail: the move itself, the way the stash directory vanishing
 * under it would on a network path or `\\wsl.localhost`, the move of the live CLAUDE.md alone, the
 * way EPERM or EBUSY does on Windows while another process holds that file open, or reading the
 * live CLAUDE.md, the way a permission or a lock another process holds does. `readAfterRename` arms the read failure only
 * once the move has happened, which is the one window where a restore has already brought the
 * user's file back. Everything else in the module keeps the real filesystem.
 */
const faults = vi.hoisted(() => ({
  rename: null as NodeJS.ErrnoException | null,
  liveRename: null as NodeJS.ErrnoException | null,
  readClaudeMd: null as NodeJS.ErrnoException | null,
  readAfterRename: null as NodeJS.ErrnoException | null,
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (faults.rename) throw faults.rename;
      // Only the live file is named plain CLAUDE.md: the stash is CLAUDE.md.disabled
      if (faults.liveRename && from.endsWith('CLAUDE.md')) throw faults.liveRename;
      const moved = await actual.rename(from, to);
      if (faults.readAfterRename) faults.readClaudeMd = faults.readAfterRename;
      return moved;
    },
    readFile: async (file: string, encoding: BufferEncoding) => {
      if (faults.readClaudeMd && file.endsWith('CLAUDE.md')) throw faults.readClaudeMd;
      return actual.readFile(file, encoding);
    },
  };
});

import { buildProjectIndex, readProjectIndexInfo, restoreProjectIndex, stashProjectIndex } from '../project-index';

let project: string;
const claudeMd = () => path.join(project, 'CLAUDE.md');
const stashed = () => path.join(project, '.workbench', 'CLAUDE.md.disabled');

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), 'project-index-'));
  mkdirSync(path.join(project, '.workbench'), { recursive: true });
  runClaudeTextMock.mockReset();
  faults.rename = null;
  faults.liveRename = null;
  faults.readClaudeMd = null;
  faults.readAfterRename = null;
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('the project index', () => {
  it('is nothing until the project has a CLAUDE.md', async () => {
    expect(await readProjectIndexInfo(project)).toBeNull();

    writeFileSync(claudeMd(), '# CLAUDE.md\n\nTwo lines.\n');
    const info = await readProjectIndexInfo(project);
    expect(info?.lines).toBe(4);
    expect(Date.parse(info?.builtAt ?? '')).not.toBeNaN();
  });

  it('switching it off keeps the file, out of where sessions read it', async () => {
    writeFileSync(claudeMd(), '# Hand-written, never committed\n');
    writeFileSync(path.join(project, 'README.md'), '# readme\n');

    await stashProjectIndex(project);

    expect(existsSync(claudeMd())).toBe(false);
    expect(await readProjectIndexInfo(project)).toBeNull();
    expect(readFileSync(stashed(), 'utf-8')).toBe('# Hand-written, never committed\n');
    expect(existsSync(path.join(project, 'README.md'))).toBe(true);
  });

  /**
   * What switching Use CLAUDE.md on asks for: the file the switch-off set aside, else a fresh run.
   * The Rebuild button calls `switchOn()` without it and always runs `/init`.
   */
  const switchOn = () => buildProjectIndex(project, undefined, { restore: true });

  it('switching it on again brings the same file back, without a run', async () => {
    writeFileSync(claudeMd(), '# Hand-written, never committed\n');

    await stashProjectIndex(project);
    const info = await switchOn();

    expect(runClaudeTextMock).not.toHaveBeenCalled();
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Hand-written, never committed\n');
    expect(existsSync(stashed())).toBe(false);
    expect(info.lines).toBe(2);
  });

  /**
   * Rebuild means "read the codebase again". The live file can be gone at that moment for reasons
   * that have nothing to do with the switch - another window turned the index off, or the file was
   * deleted outside the app - and answering with the copy set aside would hand the user an old
   * CLAUDE.md, report it as a successful rebuild, and leave the switch off.
   */
  it('rebuilds with /init rather than handing back the file set aside', async () => {
    writeFileSync(claudeMd(), '# Hand-written, never committed\n');
    await stashProjectIndex(project);
    runClaudeTextMock.mockImplementation(async () => {
      writeFileSync(claudeMd(), '# Written by /init\n');
      return { text: '' };
    });

    const info = await buildProjectIndex(project);

    expect(runClaudeTextMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Written by /init\n');
    // And the copy set aside is still waiting, for the switch that does ask for it
    expect(readFileSync(stashed(), 'utf-8')).toBe('# Hand-written, never committed\n');
    expect(info.lines).toBe(2);
  });

  /**
   * Two windows on one project: a restore must not be answered by a Rebuild already running. It
   * would otherwise report that run's output as the file it was asked to hand back, without ever
   * looking for one. Evaluating it for real is the point - what it then finds depends on what the
   * Rebuild left in the project root, which is the race between the two windows, not this.
   */
  it('runs a restore of its own rather than joining a rebuild already under way', async () => {
    writeFileSync(stashed(), '# Hand-written, never committed\n');
    let releaseFirst: () => void = () => undefined;
    const firstStarted = new Promise<void>((started) => {
      runClaudeTextMock.mockImplementationOnce(async () => {
        started();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        writeFileSync(claudeMd(), '# Written by /init\n');
        return { text: '' };
      });
    });
    // Anything after the first answers at once
    runClaudeTextMock.mockImplementation(async () => {
      writeFileSync(claudeMd(), '# Written by a later /init\n');
      return { text: '' };
    });

    // Window A presses Rebuild; window B switches the index on while that run is still going
    const rebuilding = buildProjectIndex(project);
    await firstStarted;
    const switchingOn = switchOn();
    releaseFirst();

    await expect(rebuilding).resolves.toBeDefined();
    await expect(switchingOn).resolves.toBeDefined();
    // Two runs: the Rebuild's, and the restore's own evaluation afterwards. Joining the Rebuild
    // would have answered the switch with its result and left the count at one
    expect(runClaudeTextMock).toHaveBeenCalledTimes(2);
    // The copy set aside is still there for a switch-on that finds the root empty
    expect(readFileSync(stashed(), 'utf-8')).toBe('# Hand-written, never committed\n');
  });

  it('writes one with /init when the project has nothing waiting', async () => {
    runClaudeTextMock.mockImplementation(async () => {
      writeFileSync(claudeMd(), '# Written by /init\n');
      return { text: '' };
    });

    const info = await buildProjectIndex(project);

    expect(runClaudeTextMock).toHaveBeenCalledTimes(1);
    expect(info.lines).toBe(2);
  });

  it('leaves the live CLAUDE.md alone when a restore is asked for', async () => {
    writeFileSync(claudeMd(), '# The one sessions read\n');
    writeFileSync(stashed(), '# Set aside long ago\n');

    expect(await restoreProjectIndex(project)).toEqual({ restored: false, info: null });
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# The one sessions read\n');
    expect(existsSync(stashed())).toBe(true);
  });

  it('switching it off for a project that has none is not an error', async () => {
    await expect(stashProjectIndex(project)).resolves.toBeUndefined();
    expect(existsSync(stashed())).toBe(false);
  });

  it('switching it off for a project that has none creates nothing, not even .workbench', async () => {
    rmSync(path.join(project, '.workbench'), { recursive: true, force: true });

    await expect(stashProjectIndex(project)).resolves.toBeUndefined();

    // `.workbench` existing is what marks a project as initialized, so a switch the user turned
    // off must not set up a checkout that was never set up
    expect(existsSync(path.join(project, '.workbench'))).toBe(false);
  });

  it('switching it off for a project with no .workbench sets the file aside without creating one', async () => {
    rmSync(path.join(project, '.workbench'), { recursive: true, force: true });
    writeFileSync(claudeMd(), '# Hand-written, never committed\n');

    await stashProjectIndex(project);

    // `.workbench` existing is what marks a project as initialized, so one knowledge switch must
    // not set up a checkout the user never set up; the file waits beside itself instead
    expect(existsSync(path.join(project, '.workbench'))).toBe(false);
    expect(existsSync(claudeMd())).toBe(false);
    expect(readFileSync(path.join(project, 'CLAUDE.md.disabled'), 'utf-8')).toBe('# Hand-written, never committed\n');
  });

  it('switching it on again brings back a file set aside before the project was initialized', async () => {
    rmSync(path.join(project, '.workbench'), { recursive: true, force: true });
    writeFileSync(path.join(project, 'CLAUDE.md.disabled'), '# Hand-written, never committed\n');

    const info = await switchOn();

    expect(runClaudeTextMock).not.toHaveBeenCalled();
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Hand-written, never committed\n');
    expect(existsSync(path.join(project, 'CLAUDE.md.disabled'))).toBe(false);
    expect(info.lines).toBe(2);
  });

  it('reports a failure that leaves the file where every session reads it', async () => {
    writeFileSync(claudeMd(), '# The one sessions read\n');
    faults.rename = Object.assign(new Error('ENOENT: the stash directory went away'), { code: 'ENOENT' });

    // Reporting success here would switch the row off while Claude Code goes on loading the file
    await expect(stashProjectIndex(project)).rejects.toThrow('went away');
    expect(existsSync(claudeMd())).toBe(true);
  });

  it('switching it off reports a failure when the CLAUDE.md there cannot be read', async () => {
    writeFileSync(claudeMd(), '# The one sessions read\n');
    faults.readClaudeMd = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    // A file that could not be read is not a project without one: taking it for one would skip the
    // move as "already off" and report success while every session goes on loading the file
    await expect(stashProjectIndex(project)).rejects.toThrow('permission denied');
    expect(existsSync(claudeMd())).toBe(true);
    expect(existsSync(stashed())).toBe(false);
    // The UI reads the same file through its own call, where there is only "none" to report
    expect(await readProjectIndexInfo(project)).toBeNull();
  });

  it('switching it off again sets the newer file aside and keeps the older one beside it', async () => {
    writeFileSync(stashed(), '# Set aside long ago\n');
    writeFileSync(claudeMd(), '# The newer one\n');

    await stashProjectIndex(project);

    expect(existsSync(claudeMd())).toBe(false);
    // A restore hands back the file set aside most recently, so that one takes the stash's name
    expect(readFileSync(stashed(), 'utf-8')).toBe('# The newer one\n');
    // The file that landed is whatever the project root held, which need not be a newer version of
    // the one set aside before, so the switch-off keeps that copy rather than deleting it
    expect(readFileSync(`${stashed()}.superseded`, 'utf-8')).toBe('# Set aside long ago\n');
  });

  it('a move that fails leaves the file set aside last time where a restore looks for it', async () => {
    writeFileSync(stashed(), '# Set aside long ago\n');
    writeFileSync(claudeMd(), '# The one sessions read\n');
    faults.liveRename = Object.assign(new Error('EBUSY: another process holds it open'), { code: 'EBUSY' });

    // Nothing was gained by the failed switch, so nothing may have been lost by it: the file the
    // user set aside last time is the only copy of work they may never have committed
    await expect(stashProjectIndex(project)).rejects.toThrow('another process holds it open');
    expect(readFileSync(stashed(), 'utf-8')).toBe('# Set aside long ago\n');
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# The one sessions read\n');
    expect(existsSync(`${stashed()}.superseded`)).toBe(false);
  });

  it('a copy held by an interrupted switch-off is not moved over by the next one', async () => {
    // A switch-off that stopped between its two moves — the app quit, the machine went down —
    // leaves the file it was holding behind, and that copy is the only one the project has of it
    writeFileSync(`${stashed()}.superseded`, '# Held by the switch-off that never finished\n');
    writeFileSync(stashed(), '# Set aside long ago\n');
    writeFileSync(claudeMd(), '# The newer one\n');

    await stashProjectIndex(project);

    expect(readFileSync(stashed(), 'utf-8')).toBe('# The newer one\n');
    expect(readFileSync(`${stashed()}.superseded`, 'utf-8')).toBe('# Held by the switch-off that never finished\n');
    // This call moved last time's file to the next free name, where it stays
    expect(readFileSync(`${stashed()}.superseded-2`, 'utf-8')).toBe('# Set aside long ago\n');
  });

  it('switching it on again brings back the copy an interrupted switch-off was holding', async () => {
    // Nothing is in the stash because the interrupted call never got as far as moving the live
    // file in, so the hold is the project's only copy: a `/init` run here, or a switch that said
    // there was nothing waiting, would lose the user's own work
    writeFileSync(`${stashed()}.superseded`, '# Hand-written, never committed\n');

    const info = await switchOn();

    expect(runClaudeTextMock).not.toHaveBeenCalled();
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Hand-written, never committed\n');
    expect(existsSync(`${stashed()}.superseded`)).toBe(false);
    expect(info.lines).toBe(2);
  });

  it('a restore takes the newest copy waiting and leaves the older ones where they are', async () => {
    writeFileSync(`${stashed()}.superseded`, '# The oldest copy\n');
    writeFileSync(`${stashed()}.superseded-2`, '# The copy held after it\n');

    await switchOn();

    // A hold takes the lowest free number, so the highest one was held last
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# The copy held after it\n');
    expect(readFileSync(`${stashed()}.superseded`, 'utf-8')).toBe('# The oldest copy\n');
  });

  it('keeps a hand-written file a /init run took the place of in the project root', async () => {
    // The whole path, as a user walks it: a hand-written CLAUDE.md that was never committed is set
    // aside, something writes a new one into the project root while the switch is off, and the
    // switch going back on finds that file there, so it rebuilds rather than restoring
    writeFileSync(claudeMd(), '# Hand-written, never committed\n');
    await stashProjectIndex(project);
    writeFileSync(claudeMd(), '# Written by a task run\n');
    runClaudeTextMock.mockImplementation(async () => {
      writeFileSync(claudeMd(), '# Written by /init\n');
      return { text: '' };
    });
    await switchOn();
    expect(runClaudeTextMock).toHaveBeenCalledTimes(1);

    // Switching off again sets the generated file aside, and the file it supersedes is not a newer
    // version of itself at all: it is the user's own work, and the only copy of it
    await stashProjectIndex(project);

    expect(readFileSync(stashed(), 'utf-8')).toBe('# Written by /init\n');
    expect(readFileSync(`${stashed()}.superseded`, 'utf-8')).toBe('# Hand-written, never committed\n');

    // And it is still reachable from the switch: the restore that empties the stash is followed by
    // one that hands back the copy waiting beside it, with no `/init` run in between
    await switchOn();
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Written by /init\n');
    rmSync(claudeMd());
    const info = await switchOn();

    expect(runClaudeTextMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Hand-written, never committed\n');
    expect(info.lines).toBe(2);
  });

  it('never runs /init after a restore that moved the file, even unread', async () => {
    writeFileSync(stashed(), '# Hand-written, never committed\n');
    faults.readAfterRename = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    // The file is back in the project root; a `/init` run here would overwrite the user's own work
    await expect(switchOn()).rejects.toThrow('could not read it back');
    expect(runClaudeTextMock).not.toHaveBeenCalled();
    expect(readFileSync(claudeMd(), 'utf-8')).toBe('# Hand-written, never committed\n');
  });
});
