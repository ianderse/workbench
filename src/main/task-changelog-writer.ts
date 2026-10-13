/**
 * Writes the project's task changelog (see `task-changelog.ts`) from the task hooks: an entry
 * for every state a task enters (with the files its branch changes so far) and, while it runs,
 * for the files its Claude Code session starts editing.
 */
import { execFile } from 'child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import type { Project, Task } from '../shared/types';
import { taskHooks, type TaskHookEvents } from './task-hooks';
import { getTaskChangelogPath, type TaskChangelogEntry } from './task-changelog';
import { findTaskWorktree } from './worktree-paths';
import { getToolPath } from './cli-tool-manager';
import { getIsolatedGitEnv } from './utils/git-isolation';
import { appLog } from './app-logger';

const execFileAsync = promisify(execFile);

/** Edits are collected for a moment and written as one entry */
const EDIT_FLUSH_MS = 3000;
/** Past this size the file keeps only its newest entries */
const MAX_FILE_BYTES = 1024 * 1024;
const KEEP_ENTRIES = 2000;

/** Entries per file, built and appended one at a time in the order of their events */
const writes = new Map<string, Promise<void>>();
/** `<file>\0<task>` -> the task's last state, to skip repeats */
const lastStates = new Map<string, string>();
/** `<file>\0<task>` -> files already logged for the task's current work */
const loggedFiles = new Map<string, Set<string>>();
const pendingEdits = new Map<string, { project: Project; task: Task; files: Set<string>; timer: ReturnType<typeof setTimeout> }>();

function changelogFile(project: Project): string | null {
  return project.autoBuildPath ? getTaskChangelogPath(project.path, project.autoBuildPath) : null;
}

function enqueue(file: string, build: () => Promise<TaskChangelogEntry | null>): Promise<void> {
  const previous = writes.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const entry = await build();
      if (!entry) return;
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8');
      if ((await stat(file)).size > MAX_FILE_BYTES) {
        const lines = (await readFile(file, 'utf-8')).split('\n').filter((line) => line.trim());
        await writeFile(file, `${lines.slice(-KEEP_ENTRIES).join('\n')}\n`, 'utf-8');
      }
    } catch (error) {
      appLog.warn('[TaskChangelog] Could not write', file, error);
    }
  });
  writes.set(file, next);
  return next;
}

async function git(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(getToolPath('git'), args, { cwd, env: getIsolatedGitEnv(), timeout: 15000 });
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The task's branch and every file it changes against its base branch (committed or not) */
async function branchChanges(project: Project, task: Task): Promise<{ branch?: string; files: string[] } | null> {
  if (task.metadata?.useWorktree === false) return null;
  const worktree = findTaskWorktree(project.path, task.specId);
  if (!worktree) return { files: [] };
  const base = task.metadata?.baseBranch || project.settings?.mainBranch || 'main';
  const [branch, committed, uncommitted, untracked] = await Promise.all([
    git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(worktree, ['diff', '--name-only', `${base}...HEAD`]),
    git(worktree, ['diff', '--name-only', 'HEAD']),
    git(worktree, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const dataDir = `${(project.autoBuildPath || '.auto-claude').replace(/\\/g, '/')}/`;
  const files = [...new Set([...committed, ...uncommitted, ...untracked])].filter((file) => !file.startsWith(dataDir)).sort();
  return { branch: branch[0], files };
}

function onState({ project, task, status, state }: TaskHookEvents['state']): Promise<void> {
  const file = changelogFile(project);
  if (!file) return Promise.resolve();
  const key = `${file}\0${task.specId}`;
  // Edits made before the state change are logged first
  void flushEdits(key);
  const signature = `${status}\0${state ?? ''}`;
  if (lastStates.get(key) === signature) return writes.get(file) ?? Promise.resolve();
  lastStates.set(key, signature);

  const at = new Date().toISOString();
  return enqueue(file, async () => {
    const changes = await branchChanges(project, task);
    if (changes) loggedFiles.set(key, new Set(changes.files));
    return {
      at,
      task: task.specId,
      title: task.title || undefined,
      event: 'state',
      status,
      ...(state ? { state } : {}),
      ...(changes?.branch ? { branch: changes.branch } : {}),
      ...(changes ? { files: changes.files } : {}),
    };
  });
}

function flushEdits(key: string): Promise<void> {
  const pending = pendingEdits.get(key);
  if (!pending) return Promise.resolve();
  clearTimeout(pending.timer);
  pendingEdits.delete(key);
  const file = changelogFile(pending.project);
  if (!file) return Promise.resolve();
  const at = new Date().toISOString();
  return enqueue(file, async () => {
    const logged = loggedFiles.get(key) ?? new Set<string>();
    const files = [...pending.files].filter((edited) => !logged.has(edited)).sort();
    if (files.length === 0) return null;
    for (const edited of files) logged.add(edited);
    loggedFiles.set(key, logged);
    return { at, task: pending.task.specId, title: pending.task.title || undefined, event: 'edit', files };
  });
}

function onFilesEdited({ project, task, files }: TaskHookEvents['files-edited']): void {
  const file = changelogFile(project);
  if (!file || files.length === 0) return;
  const key = `${file}\0${task.specId}`;
  const pending = pendingEdits.get(key);
  if (pending) {
    for (const edited of files) pending.files.add(edited);
    return;
  }
  pendingEdits.set(key, {
    project,
    task,
    files: new Set(files),
    timer: setTimeout(() => void flushEdits(key), EDIT_FLUSH_MS),
  });
}

/** Start writing the task changelog; returns a function that stops it */
export function registerTaskChangelog(): () => void {
  const offState = taskHooks.on('state', onState);
  const offEdits = taskHooks.on('files-edited', onFilesEdited);
  return () => {
    offState();
    offEdits();
  };
}

/**
 * Write pending edits now and wait for every write
 * @internal
 */
export async function flushTaskChangelog(): Promise<void> {
  await Promise.all([...pendingEdits.keys()].map(flushEdits));
  await Promise.all(writes.values());
}
