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

import { execFile } from 'child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { appLog } from '../app-logger';
import { getIsolatedGitEnv } from '../utils/git-isolation';
import { waitForMemoryIndexBuild } from './backfill';
import { MEMORY_INDEX_STUB } from './memory-writer';
import { getCompengDir, getMemoryIndexImportPath, getMemoryIndexPath, getStashedCompengDir } from './paths';
import { SELF_IMPROVE_MEMORY_FILE, SELF_IMPROVE_MEMORY_FILENAME } from './nudge';

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

const execFileAsync = promisify(execFile);

/**
 * Everything the store holds: the memories, the index, and the build's own stats.
 *
 * `index.json` travels with the memories on purpose. Leaving it behind would make a project that
 * already learned plenty look like it had never built an index, and switching the feature back on
 * would scan every past session again for memories it already has.
 */
async function listStoreFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.md') || name === 'index.json');
  } catch {
    return [];
  }
}

/**
 * Whether git tracks anything in the directory. Committed memories are team memory the user chose to
 * share, so they are never moved out from under a commit.
 *
 * A project that is not a git repository tracks nothing, so the listing failing for that reason is an
 * answer rather than an error. Any other failure counts as tracked: leaving files where they are is
 * the recoverable mistake.
 */
async function isTrackedByGit(dir: string, projectPath: string): Promise<boolean> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: projectPath, env: getIsolatedGitEnv() });
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

/** Union of two memory indexes: every entry line once, keyed by the file it links to */
function mergeIndexes(into: string, from: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of [...into.split('\n'), ...from.split('\n')]) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('<!--')) continue;
    const target = /\]\(([^)]+)\)/.exec(trimmed)?.[1] ?? trimmed;
    if (seen.has(target)) continue;
    seen.add(target);
    lines.push(trimmed);
  }
  return lines.length === 0 ? MEMORY_INDEX_STUB : `${lines.join('\n')}\n`;
}

/**
 * Move every memory from one directory into another and remove the source.
 *
 * A name that exists on both sides keeps both files, the incoming one suffixed, because dropping one
 * silently would lose a memory the user never asked to lose. The index is merged rather than
 * replaced; duplicate guidance is something a later session folds together on its own.
 */
async function moveMemories(from: string, to: string): Promise<number> {
  const files = await listStoreFiles(from);
  if (files.length === 0) {
    await rm(from, { recursive: true, force: true });
    return 0;
  }
  await mkdir(to, { recursive: true });

  let moved = 0;
  for (const name of files) {
    const source = path.join(from, name);
    const content = await readIfPresent(source);
    if (content === null) continue;

    if (name === 'MEMORY.md') {
      const existing = (await readIfPresent(path.join(to, name))) ?? '';
      await writeFile(path.join(to, name), mergeIndexes(existing, content), 'utf-8');
      continue;
    }

    // Stats describe one build; the side being restored keeps whichever it already has
    if (name === 'index.json') {
      if ((await readIfPresent(path.join(to, name))) === null) {
        await writeFile(path.join(to, name), content, 'utf-8');
      }
      continue;
    }

    let target = path.join(to, name);
    if ((await readIfPresent(target)) !== null) {
      target = path.join(to, `${name.replace(/\.md$/, '')}.restored.md`);
    }
    await writeFile(target, content, 'utf-8');
    moved += 1;
  }

  await rm(from, { recursive: true, force: true });
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
 * Merge one key into a settings file, keeping everything else in it. `value: null` removes the key.
 * A settings file that can't be parsed is left alone: overwriting a user's settings to turn a
 * feature on is worse than the feature not working.
 */
async function patchSettings(dir: string, key: string, value: string | null): Promise<void> {
  const file = path.join(dir, LOCAL_SETTINGS_FILE);
  const existing = await readIfPresent(file);
  let settings: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a JSON object');
      }
      settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `${file} could not be read as JSON, so it was left unchanged: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

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
  await patchSettings(projectPath, AUTO_MEMORY_DIRECTORY_KEY, compengDir);

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
    await patchSettings(worktreePath, AUTO_MEMORY_DIRECTORY_KEY, getCompengDir(projectPath));
  } catch (error) {
    appLog.warn(`[SelfImprove] Could not point ${worktreePath} at the project's memory:`, error);
  }
}
