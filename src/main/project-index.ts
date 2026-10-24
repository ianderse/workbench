/**
 * The project index: the project's CLAUDE.md, written by Claude Code's own `/init`.
 *
 * Every agent session in a project reads its CLAUDE.md before anything else, so that file is what
 * the project is indexed as for the agents. Writing it by hand is work the agent can do better:
 * a short triage run with `/init` reads the codebase and writes what a session needs to know.
 * It is re-runnable, which is how a project folds in what changed since the last one.
 */

import { readdir, readFile, rename, stat } from 'fs/promises';
import path from 'path';
import type { ProjectIndexInfo } from '../shared/types/cli';
import type { AppSettings } from '../shared/types/settings';
import { appLog } from './app-logger';
import { READ_ONLY_TOOLS, runClaudeText } from './claude-code/run-text';
import { resolveClaudeCodeTaskSettings } from './claude-code/settings';
import { readSettingsFile } from './settings-utils';
import { isOmpBackend } from './agent-backend/settings';

/** What `/init` writes, and what every session in the project reads */
const CLAUDE_MD = 'CLAUDE.md';

/** Enough reasoning to tell what a session needs to know from what it can read for itself */
const EFFORT = 'medium';
/** Reading a codebase takes a while; a run that is still going after this is stuck */
const TIMEOUT_MS = 10 * 60 * 1000;

/** One build per project at a time; a second request joins the first */
const inFlight = new Map<string, Promise<ProjectIndexInfo>>();

const claudeMdPath = (projectPath: string) => path.join(projectPath, CLAUDE_MD);

/** The name the project's CLAUDE.md waits under while the index is switched off */
const STASHED_CLAUDE_MD = `${CLAUDE_MD}.disabled`;

/** Whether a folder is there to be written into */
async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the project's CLAUDE.md waits while the index is switched off, the place a new stash takes
 * first.
 *
 * The file is the switch: Claude Code reads it because it is in the project root, so switching
 * off has to take it out of there. Deleting it instead would throw away a file the user may have
 * written by hand and never committed, so it moves aside and switching back on restores it, the
 * way the learned preferences are set aside (`getStashedCompengDir`).
 *
 * It waits under `.workbench` whenever the project has one: that folder is git-ignored, so a file
 * set aside there never turns up in the user's `git status`. A project without `.workbench` is one
 * Workbench never initialized, and that folder existing is precisely what marks a project as
 * initialized (`isInitialized`, and `applyProjectMemory` refuses to create it for this same
 * reason), so creating it here would have one knowledge switch set up a checkout the user never
 * set up — and leave it looking initialized while holding none of the folders an initialized
 * project has. Such a project sets the file aside beside itself in the project root instead, which
 * needs no new directory and keeps the switch working rather than refusing the user something that
 * can be done without writing anything new.
 *
 * Both places are read back when the switch goes on again, `.workbench` first, since that is where
 * a stash lands whenever it can and so holds the newer file of the two.
 */
async function stashedClaudeMdPaths(projectPath: string): Promise<[string, ...string[]]> {
  const underData = path.join(projectPath, '.workbench', STASHED_CLAUDE_MD);
  const inRoot = path.join(projectPath, STASHED_CLAUDE_MD);
  // With no `.workbench` there is nothing under it either, so the project root is the only place
  return (await isDirectory(path.join(projectPath, '.workbench'))) ? [underData, inRoot] : [inRoot];
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** A path that leads nowhere, which is simply a project with no CLAUDE.md */
const isMissing = (code?: string) => code === 'ENOENT' || code === 'ENOTDIR';

/**
 * What the project root says about its CLAUDE.md. The third answer is the one that matters: a read
 * that fails for any reason other than the file being gone (a permission, a lock another process
 * holds on Windows, a `\\wsl.localhost` path that blinked) says nothing about whether the project
 * has one, and both halves of the switch do the wrong thing when they take it for "it has none".
 * Switching off would leave CLAUDE.md where every session reads it and report the index as off,
 * and switching on would run `/init` over a file the user may have written by hand.
 */
type ProjectIndexProbe =
  | { state: 'present'; info: ProjectIndexInfo }
  | { state: 'none' }
  | { state: 'unknown'; error: unknown };

async function probeProjectIndex(projectPath: string): Promise<ProjectIndexProbe> {
  const file = claudeMdPath(projectPath);
  try {
    const stats = await stat(file);
    // A directory of that name is not something a session can read, so it counts as having none
    if (!stats.isFile()) return { state: 'none' };
    const content = await readFile(file, 'utf-8');
    // The file is the truth about when it was written: it is as often edited by hand as rebuilt
    return { state: 'present', info: { lines: content.split('\n').length, builtAt: stats.mtime.toISOString() } };
  } catch (error) {
    return isMissing(errorCode(error)) ? { state: 'none' } : { state: 'unknown', error };
  }
}

/** What to raise rather than move a CLAUDE.md whose state could not be established */
const unknownIndexError = (projectPath: string, error: unknown) =>
  new Error(
    `Could not tell whether ${projectPath} has a ${CLAUDE_MD}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error }
  );

/**
 * Stats of the project's CLAUDE.md, or null when it has none. A file that cannot be read comes
 * back as null too, because this is what the UI reads and the switch there has nowhere to put a
 * third answer; the two halves of the switch go through `probeProjectIndex` instead, where that
 * difference decides whether anything is moved.
 */
export async function readProjectIndexInfo(projectPath: string): Promise<ProjectIndexInfo | null> {
  const probe = await probeProjectIndex(projectPath);
  return probe.state === 'present' ? probe.info : null;
}

/** Whether a build is running for the project */
export function isProjectIndexBuilding(projectPath: string): boolean {
  return inFlight.has(path.resolve(projectPath));
}

const OMP_INIT_PROMPT = `Analyze this codebase and create a ${CLAUDE_MD} file in the project root (the current directory) for future coding agents working in this repository.

Include:
- Commonly used commands: how to build, lint and run tests, including how to run a single test
- High-level architecture and code structure: the big picture that needs several files to understand
- Important conventions visible in the code and git history

Keep it concise. Don't list every file or invent sections you can't support from the code. Read the README and any existing agent instruction files (AGENTS.md, .cursorrules, .github/copilot-instructions.md) and keep what is important. Start the file with:

# ${CLAUDE_MD}

This file provides guidance to coding agents when working with code in this repository.

Write the file with your write tool. When it is written, reply with one short sentence.`;

async function run(projectPath: string, profileId?: string): Promise<ProjectIndexInfo> {
  const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
  const { triageModel } = resolveClaudeCodeTaskSettings(settings.claudeCodeTasks);

  const omp = isOmpBackend();
  await runClaudeText({
    // `/init` is a Claude Code command; OMP gets what it does spelled out
    prompt: omp ? OMP_INIT_PROMPT : `/init`,
    model: triageModel,
    effort: EFFORT,
    cwd: projectPath,
    // `/init` is a command, so the prompt has to keep its slash
    slashCommands: !omp,
    tools: [...READ_ONLY_TOOLS, 'Write', 'Edit', 'Bash'],
    // It reads the project and writes the one file; the git reads are how it sees the conventions
    allowedTools: ['Write', 'Edit', 'Bash(git ls-files *)', 'Bash(git log *)'],
    maxTurns: 40,
    timeoutMs: TIMEOUT_MS,
    profileId,
  });

  const info = await readProjectIndexInfo(projectPath);
  if (!info) throw new Error(`The run finished without writing ${CLAUDE_MD}`);
  appLog.info(`[ProjectIndex] Wrote ${CLAUDE_MD} for ${projectPath}: ${info.lines} line(s)`);
  return info;
}

/**
 * Move a file to a name of its own, reporting whether there was one to move. A path that leads
 * nowhere is the ordinary case of nothing waiting there; any other failure is raised, because the
 * caller is holding a file out of the way and must not go on as if it had.
 */
async function moveAside(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if (isMissing(errorCode(error))) return false;
    throw error;
  }
}

/**
 * The name a superseded stash moves to and then keeps: the stash's own name plus the suffix,
 * numbered from the second one on.
 */
const supersededHold = (stash: string, hold: number) => `${stash}.superseded${hold === 1 ? '' : `-${hold}`}`;

/** The part of a hold's name that follows the stash's own */
const SUPERSEDED_SUFFIX = /^\.superseded(?:-([1-9]\d*))?$/;

/**
 * As many superseded copies of one stash as a user could plausibly ask back for. Reaching it is a
 * reported failure rather than a file quietly going away (`freeSupersededHold`), and the copies are
 * the user's to read and delete: a project that collected a hundred of them has something going on
 * that the app guessing which ones are stale would only make worse.
 */
const SUPERSEDED_HOLD_LIMIT = 100;

/**
 * The holds waiting beside the stash, by number, highest first — which is newest first, since each
 * hold takes the lowest number free when it was made and keeps it from then on.
 *
 * The folder is listed rather than the names probed one at a time so that a gap — a copy the user
 * looked through and deleted by hand, which is the only thing that frees one of these names —
 * cannot hide the copies past it. A folder that is not there holds nothing, which is the ordinary
 * case for a project that was never switched off; any other failure is raised, because both callers
 * are about to move a file the user may never have committed and must not do that half-informed.
 */
async function supersededHolds(stash: string): Promise<number[]> {
  const prefix = path.basename(stash);
  let entries: string[];
  try {
    entries = await readdir(path.dirname(stash));
  } catch (error) {
    if (isMissing(errorCode(error))) return [];
    throw error;
  }
  const holds: number[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = SUPERSEDED_SUFFIX.exec(entry.slice(prefix.length));
    if (suffix) holds.push(suffix[1] ? Number(suffix[1]) : 1);
  }
  return holds.sort((a, b) => b - a);
}

/**
 * A free name to keep the superseded stash under, never one that is taken.
 *
 * Every one of these files is a CLAUDE.md the user may have written by hand and never committed:
 * the copy a switch-off that was interrupted between its two moves — the process exits, the machine
 * goes down — left behind, and the copy every earlier switch-off is keeping beside the stash.
 * Renaming over either would destroy exactly the file the whole stash exists to keep, so the name is
 * numbered the way `freeName` in `self-improve/relocation.ts` numbers its own restored copies, for
 * the same reason.
 */
async function freeSupersededHold(stash: string): Promise<string> {
  const taken = new Set(await supersededHolds(stash));
  for (let hold = 1; hold <= SUPERSEDED_HOLD_LIMIT; hold += 1) {
    if (!taken.has(hold)) return supersededHold(stash, hold);
  }
  // Giving up beats overwriting one of them: the switch reports the failure and the project keeps
  // both its CLAUDE.md and every copy set aside so far
  throw new Error(`${stash} already has ${SUPERSEDED_HOLD_LIMIT} superseded copies waiting beside it`);
}

/**
 * Switch the project index off: move the project's CLAUDE.md aside, stopping a build that is
 * writing it first. The file is the switch, so leaving it in the project root would switch
 * itself back on; nothing is deleted, because the file may be the user's own work.
 */
export async function stashProjectIndex(projectPath: string): Promise<void> {
  await inFlight.get(path.resolve(projectPath))?.catch(() => undefined);
  const live = claudeMdPath(projectPath);
  const before = await probeProjectIndex(projectPath);
  // A file we could not read is still a file every session reads, so the switch reports a failure
  // rather than flipping the row off and leaving CLAUDE.md in the project root
  if (before.state === 'unknown') throw unknownIndexError(projectPath, before.error);
  // Nothing to move: the project has no CLAUDE.md, so the index is already off. Asking first is
  // what keeps the switch from touching the project folder at all for such a project.
  if (before.state === 'none') return;

  // Always a folder that is already there, so nothing is created on the way to the move
  const [stash] = await stashedClaudeMdPaths(projectPath);
  // A file already waiting there was set aside before, and rename wants the place it is moving to
  // free on Windows, so that file moves to a name of its own first. The name is a free one, so
  // neither the hold an interrupted switch-off left behind nor the one an earlier switch-off is
  // keeping is ever moved over.
  const superseded = await freeSupersededHold(stash);
  const held = await moveAside(stash, superseded);
  try {
    await rename(live, stash);
  } catch (error) {
    // This call set nothing aside, so last time's file goes back where a restore looks for it.
    // A failure to put it back is only logged: the error the caller gets has to be the one that
    // stopped the switch.
    if (held) {
      await rename(superseded, stash).catch((putBack) =>
        appLog.error(`[ProjectIndex] Could not put ${superseded} back as ${stash}:`, putBack)
      );
    }
    // Only the file being gone is tolerated, and only when it really is gone: a build that stopped
    // or the user deleting it leaves the project root the way switching off wants it. An ENOENT
    // from the other side — the stash directory vanishing under us, which a network path or
    // `\\wsl.localhost` can do — leaves CLAUDE.md where every session reads it, and reporting that
    // as success would switch the row off while Claude Code goes on loading the file.
    if (errorCode(error) === 'ENOENT' && (await probeProjectIndex(projectPath)).state === 'none') return;
    throw error;
  }
  // The copy set aside last time stays under the name it was moved to, rather than being freed now
  // that its replacement has landed. The file that just landed is whatever the project root held,
  // which need not be a newer version of the one set aside: a restore refuses while the root has a
  // CLAUDE.md, and `restoreOrBuild` then writes a fresh one there with `/init`, so a project can
  // reach this line with a generated file in the stash's place and the user's own hand-written one
  // in the hold. Deleting it on that assumption is precisely the loss setting the file aside instead
  // of removing it exists to prevent, and nothing here can tell the two cases apart.
  if (held) appLog.info(`[ProjectIndex] Kept the ${CLAUDE_MD} set aside before beside the stash, as ${superseded}`);
  appLog.info(`[ProjectIndex] Moved ${CLAUDE_MD} of ${projectPath} aside to ${stash}`);
}

/** What a restore did */
export interface ProjectIndexRestore {
  /**
   * Whether the file set aside is back in the project root. It is reported on its own because a
   * restore that worked must never be followed by a build, not even when the file it brought back
   * could not then be read.
   */
  restored: boolean;
  /** Stats of that file, null when there was nothing waiting or it could not be read */
  info: ProjectIndexInfo | null;
}

/**
 * The names a restore brings the file back from, in the order it tries them: the stash itself
 * first, then the copies held beside it, newest first.
 *
 * The holds are read too because a switch-off interrupted between its two moves leaves the file it
 * was holding behind with nothing in the stash, and that copy is then the only one the project
 * has. Looking only at the stash would make it unreachable from the Project page: the switch would
 * report the index as off with nothing waiting and go on to write a fresh CLAUDE.md with `/init`
 * over the user's own work. The stash comes first because it holds the file set aside most
 * recently, so a restore still hands back the newest copy whenever there is one, and the older ones
 * stay where they are: each is reached by the restore that finds the stash empty, which is the one
 * after this file has been set aside and handed back again.
 *
 * Moving the newest hold up into the stash's name after a restore would reach them sooner, and is
 * deliberately not done: that copy would then *be* the stash, so the next switch-off would supersede
 * it and move it right back down, one name further along, for nothing but churn in a folder of files
 * the user may want to read.
 */
async function restorable(stash: string): Promise<string[]> {
  return [stash, ...(await supersededHolds(stash)).map((hold) => supersededHold(stash, hold))];
}

/**
 * Bring back the CLAUDE.md that switching the index off set aside, and report it the way a build
 * does. `restored` is false with no stats when there was nothing waiting, which is the caller's
 * signal to write one.
 *
 * A project that already has a CLAUDE.md keeps it: the live file is what the sessions read, so an
 * older one set aside earlier never overwrites it and a rebuild stays a rebuild.
 */
export async function restoreProjectIndex(projectPath: string): Promise<ProjectIndexRestore> {
  const live = await probeProjectIndex(projectPath);
  // The move below writes over whatever the project root holds, so a live file that could not be
  // read is the one state this cannot work around: replacing the user's own file with an older
  // copy of it is worse than refusing, so it refuses.
  if (live.state === 'unknown') throw unknownIndexError(projectPath, live.error);
  if (live.state === 'present') return { restored: false, info: null };

  // A project switched off before it was initialized has its file waiting in the project root
  // rather than under `.workbench`, so both places are tried
  let moved: string | null = null;
  for (const stash of await stashedClaudeMdPaths(projectPath)) {
    for (const candidate of await restorable(stash)) {
      try {
        await rename(candidate, claudeMdPath(projectPath));
        moved = candidate;
        break;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
    }
    if (moved) break;
  }
  if (!moved) return { restored: false, info: null };
  appLog.info(`[ProjectIndex] Restored the ${CLAUDE_MD} set aside for ${projectPath} (${moved})`);

  const restored = await probeProjectIndex(projectPath);
  if (restored.state === 'unknown') {
    appLog.warn(`[ProjectIndex] Restored ${CLAUDE_MD} for ${projectPath} but could not read it:`, restored.error);
  }
  return { restored: true, info: restored.state === 'present' ? restored.info : null };
}

/**
 * Give the project a CLAUDE.md: the one switching the index off set aside when there is one,
 * else a fresh `/init` run. The restore takes precedence so that switching the index off and
 * on again hands the user their own file back rather than a regenerated one.
 */
async function restoreOrBuild(projectPath: string, profileId?: string): Promise<ProjectIndexInfo> {
  const restored = await restoreProjectIndex(projectPath);
  if (restored.info) return restored.info;
  // The file is back where the sessions read it, so there is nothing left to build. Running
  // `/init` because the restore could not be described would overwrite the user's own file with a
  // generated one, which is the loss this whole setting-aside exists to prevent, so this reports
  // the read instead.
  if (restored.restored) {
    throw new Error(`Restored the ${CLAUDE_MD} set aside for ${projectPath}, but could not read it back`);
  }
  return run(projectPath, profileId);
}

/**
 * Build the project's CLAUDE.md with `/init`. Concurrent callers join the build already running
 * rather than starting a second one.
 *
 * `restore` belongs to switching the index back on, and only there: that is the one request that
 * means "give the project the CLAUDE.md it had", so handing back the file the switch-off set aside
 * is the right answer. The Rebuild button means "read the codebase again", and answering it with a
 * file from before would hand the user an old CLAUDE.md, report it as a successful build, and leave
 * the switch off - the live file can be gone at that moment for reasons that have nothing to do
 * with the switch, such as another window turning the index off or the file being deleted outside
 * the app.
 */
export function buildProjectIndex(
  projectPath: string,
  profileId?: string,
  { restore = false }: { restore?: boolean } = {}
): Promise<ProjectIndexInfo> {
  const key = path.resolve(projectPath);
  const running = inFlight.get(key);
  if (!running) return startProjectIndexBuild(projectPath, profileId, restore);

  // A request joins a build already under way only when it asks for the same thing. A restore does
  // not: answering it with a plain `/init` already running would report that run's output as the
  // file the switch asked to have back, and leave the user's own one set aside while the switch
  // said it had succeeded. Two windows on one project are what make that reachable - one presses
  // Rebuild while the other turns the index back on - so the restore waits for the build in flight
  // and then runs for real rather than inheriting its answer.
  if (!restore) return running;
  const queued = running
    .catch(() => undefined)
    .then(() => startProjectIndexBuild(projectPath, profileId, restore));
  inFlight.set(key, queued);
  return queued;
}

/** One build, registered while it runs so the next caller can join or queue behind it */
function startProjectIndexBuild(
  projectPath: string,
  profileId: string | undefined,
  restore: boolean
): Promise<ProjectIndexInfo> {
  const key = path.resolve(projectPath);
  const build: Promise<ProjectIndexInfo> = (
    restore ? restoreOrBuild(projectPath, profileId) : run(projectPath, profileId)
  ).finally(() => {
    // Only ever its own registration: a request that queued behind this one has already taken the
    // key, and dropping that would let a third caller start a second build over it
    if (inFlight.get(key) === build) inFlight.delete(key);
  });
  inFlight.set(key, build);
  return build;
}
