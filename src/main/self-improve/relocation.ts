/**
 * Points Claude Code's auto memory at the project instead of `~/.claude/projects/<project>/memory`,
 * so every session in the project shares one store, the notes are visible in the checkout, and the
 * user can make them team memory by committing them.
 *
 * Three pieces, all small and all reversible:
 * - `autoMemoryDirectory` in the project's `.claude/settings.local.json` (machine-local: the value
 *   has to be an absolute path, so it can't be committed). Every session started anywhere in the
 *   project reads it, which is why this is a settings file and not a flag on our own runs.
 * - an `@` import of the memory index from the project's CLAUDE.md, so the notes also reach
 *   subagents, which never inherit the main conversation's auto memory.
 * - the capture instruction in the project's `.claude/MEMORY.md`, for the sessions Workbench
 *   doesn't start.
 */

import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'fs/promises';
import path from 'path';
import { appLog } from '../app-logger';
import { isClaudeHomeInWsl } from '../platform/claude-home';
import { toRuntimePath } from '../platform/shell-runtime';
import { git as runGit } from '../utils/git-exec';
import { isNodeError } from '../utils/type-guards';
import { waitForMemoryIndexBuild } from './backfill';
import { mergeIndexes, MEMORY_INDEX_STUB } from './memory-writer';
import { getCompengDir, getMemoryIndexImportPath, getMemoryIndexPath, getStashedCompengDir } from './paths';
import { SELF_IMPROVE_MEMORY_FILE, SELF_IMPROVE_MEMORY_FILENAME } from './nudge';
import { isSelfImproveEnabledForPath } from './setting';

/** The settings key Claude Code reads before it loads or saves auto memory */
const AUTO_MEMORY_DIRECTORY_KEY = 'autoMemoryDirectory';
/** Settings scope that can hold an absolute path: machine-local, not committed */
const LOCAL_SETTINGS_FILE = path.join('.claude', 'settings.local.json');
/** The capture instruction's own file in the project, committed with it */
const PROJECT_MEMORY_FILE = path.join('.claude', SELF_IMPROVE_MEMORY_FILENAME);

/**
 * Markers around the import line in CLAUDE.md. Block-level HTML comments are stripped before
 * CLAUDE.md reaches the model, so they cost no context and make the line safe to remove again.
 */
const IMPORT_START = '<!-- workbench:project-memory:start -->';
const IMPORT_END = '<!-- workbench:project-memory:end -->';

/** The build's own stats, which describe one build rather than belonging to the memories */
const INDEX_INFO_FILE = 'index.json';

/**
 * Whether git tracks anything in the directory. Committed memories are team memory the user chose to
 * share, so they are never moved out from under a commit.
 *
 * A project that is not a git repository tracks nothing, so the listing failing for that reason is an
 * answer rather than an error. Any other failure counts as tracked: leaving files where they are is
 * the recoverable mistake.
 */
async function isTrackedByGit(dir: string, projectPath: string): Promise<boolean> {
  const git = (args: string[]) => runGit(args, { cwd: projectPath, isolated: true });
  try {
    const { stdout } = await git(['ls-files', '--', dir]);
    return stdout.trim() !== '';
  } catch {
    try {
      await git(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }
}

/** Whether anything is at the path at all, file or directory */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** As many numbered copies of one name as a user could plausibly restore; past that the entry stays put */
const RESTORE_NAME_LIMIT = 100;

/** The suffix this function adds, so restoring a restored copy numbers it instead of stacking suffixes */
const RESTORED_SUFFIX = /\.restored(-\d+)?$/;

/**
 * A free name beside the one that was taken, so a collision keeps both sides: `tabs.md` becomes
 * `tabs.restored.md` and a directory `notes` becomes `notes.restored`.
 *
 * The suffix is numbered from the second collision on (`tabs.restored-2.md`) because the move is a
 * rename and a rename replaces whatever is already at the target without a word. A user who
 * switches the feature off and on twice with the same name present on both sides would otherwise
 * lose the memory the first restore saved, which is the one thing this whole function exists to
 * prevent. A name that already carries the suffix joins that same numbered run rather than
 * collecting another one, so the names stay readable however many cycles the user goes through.
 */
async function freeName(dir: string, name: string): Promise<string> {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length).replace(RESTORED_SUFFIX, '');
  for (let attempt = 1; attempt <= RESTORE_NAME_LIMIT; attempt += 1) {
    const candidate = `${stem}.restored${attempt === 1 ? '' : `-${attempt}`}${extension}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  // Giving up beats both looping forever and overwriting: the caller reports it and leaves the
  // entry in the directory it came from, where it is still there to be found
  throw new Error(`${name} already has ${RESTORE_NAME_LIMIT} restored copies in ${dir}`);
}

/**
 * Move one entry, whatever it is. A rename is the whole operation when both sides sit on the same
 * filesystem, which they do here (two folders of the same `.workbench`); a copy is the fallback for
 * the case where they don't, and the source goes only once the copy is through.
 */
async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if (!isNodeError(error) || (error.code !== 'EXDEV' && error.code !== 'EPERM')) throw error;
    await cp(source, target, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
}

/** What an index line links to, which is the one part of a line a rename has to change */
const INDEX_TARGET = /\]\(([^)]+)\)/;

/**
 * The incoming index with every line pointed at the file its memory actually ended up as, plus a
 * line for a renamed memory that index never named.
 *
 * A memory whose name was taken on the other side comes in under a suffixed one, and the index that
 * travels with it still links to the name it had before the move — which on this side is a
 * different memory altogether. `mergeIndexes` drops such a line only when the destination's own
 * index already names that file, and it does not when the user rewrote their `MEMORY.md` by hand or
 * never had a line for that memory, so the merged index would describe one memory and open another.
 * The link is rewritten here instead, before the merge, and the title and hook are kept as they
 * stand: they are the incoming memory's own words, and that memory is what the line now opens.
 *
 * A renamed memory the incoming index did not name still gets a line of its own, because a memory
 * the index does not name is a memory nothing will ever load. Only the memories are indexed, so a
 * renamed folder of clippings or a note in another format adds no line.
 */
function retargetIndex(incoming: string, renamed: Map<string, string>): string {
  const relinked = new Set<string>();
  const lines = incoming.split('\n').map((line) => {
    const target = INDEX_TARGET.exec(line)?.[1];
    const landed = target === undefined ? undefined : renamed.get(target);
    if (target === undefined || landed === undefined) return line;
    relinked.add(target);
    return line.replace(`](${target})`, `](${landed})`);
  });
  for (const [name, landed] of renamed) {
    if (relinked.has(name) || !landed.endsWith('.md')) continue;
    lines.push(`- [${name.replace(/\.md$/, '')}](${landed}) — restored, kept beside the ${name} already here`);
  }
  return lines.join('\n');
}

/**
 * Move everything one memory directory holds into another and remove the source.
 *
 * Everything means everything, not just the files this app knows how to read: a note in another
 * format, a folder of clippings, an attachment a session saved beside a memory. The directory is
 * the user's, and the switch this runs for says nothing about deleting its contents.
 *
 * A name that exists on both sides keeps both entries, the incoming one suffixed and numbered when
 * that suffix is taken as well, because dropping one silently would lose a memory the user never
 * asked to lose; a suffixed memory also gets its own index line, since a memory the index does not
 * name is a memory nothing will ever find. The index itself is merged rather than replaced, with
 * the incoming lines pointed at the names their memories ended up as (`retargetIndex`). Anything
 * that could not be moved stays where it is and is reported, and the source directory goes only
 * once it is actually empty.
 *
 * `index.json` travels with the memories on purpose. Leaving it behind would make a project that
 * already learned plenty look like it had never built an index, and switching the feature back on
 * would scan every past session again for memories it already has. Its stats describe one build,
 * though, so the side being restored keeps whichever it already has.
 */
async function moveMemories(from: string, to: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(from);
  } catch {
    // Nothing there, so there is nothing to move and nothing to remove
    return 0;
  }
  if (entries.length === 0) {
    await rm(from, { recursive: true, force: true });
    return 0;
  }
  await mkdir(to, { recursive: true });

  // Read before the loop: the merged index has to name every entry that ends up renamed, and the
  // order readdir reports says nothing about when those renames are known
  const incomingIndex = await readIfPresent(path.join(from, SELF_IMPROVE_MEMORY_FILENAME));
  // What each entry whose name was taken came in as, against what it ended up as
  const renamed = new Map<string, string>();
  let moved = 0;

  for (const name of entries) {
    if (name === SELF_IMPROVE_MEMORY_FILENAME) continue;
    const source = path.join(from, name);
    try {
      if (name === INDEX_INFO_FILE) {
        if (await exists(path.join(to, name))) await rm(source, { recursive: true, force: true });
        else await moveEntry(source, path.join(to, name));
        continue;
      }

      const taken = await exists(path.join(to, name));
      const target = taken ? await freeName(to, name) : name;
      await moveEntry(source, path.join(to, target));
      moved += 1;
      if (taken) renamed.set(name, target);
    } catch (error) {
      appLog.warn(`[SelfImprove] Could not move ${source} into ${to}, so it was left where it is:`, error);
    }
  }

  if (incomingIndex !== null || renamed.size > 0) {
    const index = path.join(to, SELF_IMPROVE_MEMORY_FILENAME);
    const merged = mergeIndexes((await readIfPresent(index)) ?? '', retargetIndex(incomingIndex ?? '', renamed));
    await writeFile(index, merged, 'utf-8');
    await rm(path.join(from, SELF_IMPROVE_MEMORY_FILENAME), { force: true });
  }

  try {
    await rmdir(from);
  } catch (error) {
    appLog.warn(`[SelfImprove] ${from} still holds something that could not be moved, so it was kept:`, error);
  }
  return moved;
}

const importBlock = (): string =>
  `${IMPORT_START}\nPreferences learned in past sessions: @${getMemoryIndexImportPath()}\n${IMPORT_END}`;

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/** The project's instruction file, whichever of the two valid locations it uses */
async function findInstructionFile(projectPath: string): Promise<string | null> {
  for (const candidate of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]) {
    const file = path.join(projectPath, candidate);
    if ((await readIfPresent(file)) !== null) return file;
  }
  return null;
}

/**
 * The memory directory as the value of the setting, which is read by Claude Code rather than by us.
 *
 * In WSL mode Claude Code runs inside the distribution and a Windows path means nothing to it, so
 * the setting states the Linux path; the directory Workbench itself creates, moves and reads stays
 * the stored host path. This is the boundary the rule about translating only at process boundaries
 * is about: a settings file one runtime writes and the other reads is one of them.
 */
function memoryDirectorySetting(projectPath: string): string {
  const directory = getCompengDir(projectPath);
  return isClaudeHomeInWsl() ? toRuntimePath(directory) : directory;
}

/**
 * The local settings of a checkout as an object, or null when there is no file to read yet.
 *
 * A file that can't be read as a JSON object throws instead of reporting an empty one, because
 * every caller here goes on to write the file back: overwriting a user's settings to turn a
 * feature on is worse than the feature not working.
 */
async function readLocalSettings(dir: string): Promise<Record<string, unknown> | null> {
  const file = path.join(dir, LOCAL_SETTINGS_FILE);
  const existing = await readIfPresent(file);
  if (existing === null || existing.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${file} could not be read as JSON, so it was left unchanged: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Merge one key into a settings file, keeping everything else in it. `value: null` removes the key. */
async function patchSettings(dir: string, key: string, value: string | null): Promise<void> {
  const file = path.join(dir, LOCAL_SETTINGS_FILE);
  const settings = (await readLocalSettings(dir)) ?? {};

  if (value === null) {
    if (!(key in settings)) return;
    delete settings[key];
  } else {
    if (settings[key] === value) return;
    settings[key] = value;
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
}

/** Add the import line to the project's instruction file, once */
async function addImport(projectPath: string): Promise<void> {
  const file = await findInstructionFile(projectPath);
  if (!file) {
    appLog.warn('[SelfImprove] No CLAUDE.md in the project, so memories will not reach subagents');
    return;
  }
  const content = await readIfPresent(file);
  if (content === null) return;
  // Either our own block or a hand-written import of the same file counts as present
  if (content.includes(IMPORT_START) || content.includes(`@${getMemoryIndexImportPath()}`)) return;

  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(file, `${content}${separator}${importBlock()}\n`, 'utf-8');
}

/** Remove the import block we added. A file whose markers are gone is left untouched. */
async function removeImport(projectPath: string): Promise<void> {
  const file = await findInstructionFile(projectPath);
  if (!file) return;
  const content = await readIfPresent(file);
  if (content === null || !content.includes(IMPORT_START)) return;

  const start = content.indexOf(IMPORT_START);
  const end = content.indexOf(IMPORT_END, start);
  if (end === -1) return;
  const after = end + IMPORT_END.length;
  const cleaned = `${content.slice(0, start).replace(/\n+$/, '\n')}${content.slice(after).replace(/^\n+/, '')}`;
  await writeFile(file, cleaned, 'utf-8');
}

/**
 * Turn the project's memory on: relocate the store, import its index, and install the capture rule.
 * Safe to run again; it changes only what isn't already in place.
 */
export async function applyProjectMemory(projectPath: string): Promise<void> {
  // `.workbench` existing is what marks a project as initialized, so this never creates it
  try {
    await readdir(path.join(projectPath, '.workbench'));
  } catch {
    throw new Error('This project is not initialized yet, so it has nowhere to keep what it learns');
  }

  const compengDir = getCompengDir(projectPath);
  await mkdir(compengDir, { recursive: true });

  // Anything set aside the last time the switch went off comes back, merged with what is here now
  const stashed = await moveMemories(getStashedCompengDir(projectPath), compengDir);
  if (stashed > 0) appLog.info(`[SelfImprove] Restored ${stashed} memory file(s) for ${projectPath}`);

  const index = getMemoryIndexPath(projectPath);
  if ((await readIfPresent(index)) === null) await writeFile(index, MEMORY_INDEX_STUB, 'utf-8');

  // The settings key is what makes the feature work, so a failure here reaches the caller
  await patchSettings(projectPath, AUTO_MEMORY_DIRECTORY_KEY, memoryDirectorySetting(projectPath));

  // The rest is best effort: without it memories are still saved and loaded, just not by sessions
  // Workbench didn't start, and not inside subagents
  try {
    const memoryFile = path.join(projectPath, PROJECT_MEMORY_FILE);
    await mkdir(path.dirname(memoryFile), { recursive: true });
    await writeFile(memoryFile, SELF_IMPROVE_MEMORY_FILE, 'utf-8');
    await addImport(projectPath);
  } catch (error) {
    appLog.warn('[SelfImprove] Could not install the project memory file or the memory import:', error);
  }
}

/**
 * Turn it off: undo the three pieces and leave every memory in place. What the project learned is
 * the user's, so switching the feature off never deletes it.
 */
export async function removeProjectMemory(projectPath: string): Promise<void> {
  await patchSettings(projectPath, AUTO_MEMORY_DIRECTORY_KEY, null);
  try {
    await rm(path.join(projectPath, PROJECT_MEMORY_FILE), { force: true });
    await removeImport(projectPath);
  } catch (error) {
    appLog.warn('[SelfImprove] Could not remove the project memory file or the memory import:', error);
  }

  // A build writes into the memory directory, so let it finish before moving the directory away
  await waitForMemoryIndexBuild(projectPath);

  // Nothing points at the memory directory any more, so set it aside rather than leave it orphaned:
  // switching the feature back on restores it. Committed memories stay put, since removing tracked
  // files on a settings toggle is not ours to do.
  const compengDir = getCompengDir(projectPath);
  try {
    if (await isTrackedByGit(compengDir, projectPath)) {
      appLog.info(`[SelfImprove] ${compengDir} is tracked by git, so it was left in place`);
      return;
    }
    const stashed = await moveMemories(compengDir, getStashedCompengDir(projectPath));
    if (stashed > 0) appLog.info(`[SelfImprove] Set aside ${stashed} memory file(s) for ${projectPath}`);
  } catch (error) {
    appLog.warn('[SelfImprove] Could not set the project memories aside:', error);
  }
}

/**
 * Give a task's worktree the project's memory directory.
 *
 * A worktree is its own checkout and `.claude/settings.local.json` isn't committed, so without this
 * a session started inside one would fall back to `~/.claude` and split the store in two. The value
 * is the primary checkout's directory, never the worktree's own.
 */
export async function ensureWorktreeProjectMemory(worktreePath: string, projectPath: string): Promise<void> {
  try {
    await patchSettings(worktreePath, AUTO_MEMORY_DIRECTORY_KEY, memoryDirectorySetting(projectPath));
  } catch (error) {
    appLog.warn(`[SelfImprove] Could not point ${worktreePath} at the project's memory:`, error);
  }
}

/**
 * Spell `autoMemoryDirectory` the way the runtime the app now runs in needs it.
 *
 * The setting is written once, when the switch goes on, and the two runtimes need two different
 * spellings of the same folder: a Windows path natively, the Linux path in WSL. So a project set up
 * under one runtime holds the other runtime's path after the user changes Settings > General >
 * Shell, and Claude Code, which only reads the value and never checks it, quietly loads and saves
 * nothing. Rewriting it on the start that follows the switch is the cheapest place to notice:
 * nothing else reads the value, so nothing else would.
 *
 * A project whose switch is off has no memory to point at; a checkout whose settings file doesn't
 * name the key at all is one this never wrote (the switch is what writes it), and creating the file
 * for it on a startup pass would be putting a file in the user's checkout for a feature they turned
 * off. Both are left alone, as is a settings file that can't be parsed.
 *
 * The task worktrees are given the same value by `ensureWorktreeProjectMemory`, each in its own
 * uncommitted settings file, so they go stale on a switch exactly as the primary checkout does and
 * are repaired with it. Their paths are passed in rather than listed here, because that listing
 * belongs to the worktree module and nothing else in this one needs it.
 *
 * @returns how many settings files were rewritten
 */
export async function repairProjectMemorySetting(projectPath: string, worktreePaths: string[] = []): Promise<number> {
  if (!(await isSelfImproveEnabledForPath(projectPath))) return 0;
  // Every checkout points at the primary checkout's store, so they all want the same value
  const wanted = memoryDirectorySetting(projectPath);
  let repaired = 0;
  for (const dir of [projectPath, ...worktreePaths]) {
    if (await repointMemorySetting(dir, wanted)) repaired += 1;
  }
  return repaired;
}

/** Rewrite one checkout's `autoMemoryDirectory`, when it holds a stale spelling of it */
async function repointMemorySetting(dir: string, wanted: string): Promise<boolean> {
  try {
    const current = (await readLocalSettings(dir))?.[AUTO_MEMORY_DIRECTORY_KEY];
    if (typeof current !== 'string' || current === wanted) return false;
    await patchSettings(dir, AUTO_MEMORY_DIRECTORY_KEY, wanted);
    appLog.info(`[SelfImprove] Pointed ${dir} at its memory as this runtime spells it: ${current} -> ${wanted}`);
    return true;
  } catch (error) {
    appLog.warn(`[SelfImprove] Could not re-point ${dir} at its memory for this runtime:`, error);
    return false;
  }
}
