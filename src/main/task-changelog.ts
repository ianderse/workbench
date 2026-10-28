/**
 * The project's task changelog: `.workbench/changelog.jsonl`, one JSON entry per line (oldest
 * first) for every state a task enters and the files its Claude Code session edits. Tasks run in
 * parallel in their own worktrees, so each task's prompt lists what the others are changing, and
 * they can search recent entries to avoid editing the same files (merge conflicts).
 *
 * This module reads the file and builds the prompt section; `task-changelog-writer.ts` writes it.
 */
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import type { TaskStatus } from '../shared/types';
import { taskSessionName } from '../shared/utils/task-messaging';
import { sanitizeChangedFiles } from '../shared/utils/changed-files';

export const TASK_CHANGELOG_FILE = 'changelog.jsonl';
/** Includes the heading, task rows, omission notice and coordination instructions. */
export const PARALLEL_TASKS_PROMPT_MAX_CHARS = 6_000;
const MAX_TASK_ROW_CHARS = 1_000;

function promptField(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, ' ').replace(/`/g, "'");
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars - 1)}…` : singleLine;
}

export interface TaskChangelogEntry {
  /** ISO time */
  at: string;
  /** Task spec id (its folder in .workbench/tasks) */
  task: string;
  title?: string;
  /** state: the task entered a state; edit: its session started editing files */
  event: 'state' | 'edit';
  status?: TaskStatus;
  /** State machine state (planning, coding, qa_review, ...) when known */
  state?: string;
  branch?: string;
  /** edit: files it started editing; state: every file its branch changes so far */
  files?: string[];
}

/** A task as the changelog last saw it */
export interface TaskChangelogTask {
  task: string;
  title?: string;
  status?: TaskStatus;
  state?: string;
  branch?: string;
  updatedAt: string;
  files: string[];
}

/** Statuses whose changes are still on their way into the base branch */
const ACTIVE_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'error']);

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Planning',
  queue: 'Queue',
  in_progress: 'In Progress',
  ai_review: 'AI Review',
  human_review: 'Human Review',
  done: 'Done',
  pr_created: 'PR Created',
  error: 'Error',
};

/** A task status as the board names it */
export function taskStatusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** The project's changelog file */
export function getTaskChangelogPath(projectPath: string, autoBuildPath: string | undefined): string {
  return path.join(projectPath, autoBuildPath || '.workbench', TASK_CHANGELOG_FILE);
}

/** Parse changelog lines; malformed lines are skipped */
export function parseTaskChangelog(content: string): TaskChangelogEntry[] {
  const entries: TaskChangelogEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TaskChangelogEntry;
      if (entry && typeof entry.task === 'string' && typeof entry.at === 'string') {
        // Older entries hold pseudo targets of the agent's tools (`agent:/x`, `conflict:/1`)
        if (Array.isArray(entry.files)) entry.files = sanitizeChangedFiles(entry.files);
        entries.push(entry);
      }
    } catch {
      // A line cut short by a crash; the next entries are still valid
    }
  }
  return entries;
}

export async function readTaskChangelog(file: string): Promise<TaskChangelogEntry[]> {
  try {
    return parseTaskChangelog(await readFile(file, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Each task's latest state. A state entry with files replaces the task's file list (it is the
 * branch's full diff); edits since then are added to it.
 */
export function foldTaskChangelog(entries: TaskChangelogEntry[]): Map<string, TaskChangelogTask> {
  const tasks = new Map<string, TaskChangelogTask>();
  for (const entry of entries) {
    const current = tasks.get(entry.task) ?? { task: entry.task, updatedAt: entry.at, files: [] };
    current.updatedAt = entry.at;
    if (entry.title) current.title = entry.title;
    if (entry.branch) current.branch = entry.branch;
    if (entry.event === 'state') {
      current.status = entry.status ?? current.status;
      current.state = entry.state;
      if (entry.files) current.files = [...entry.files];
    } else if (entry.files) {
      current.files = [...new Set([...current.files, ...entry.files])];
    }
    tasks.set(entry.task, current);
  }
  return tasks;
}

function describeTask(task: TaskChangelogTask, ownFiles: Set<string>, projectId?: string): string {
  const status = task.status ? STATUS_LABELS[task.status] : 'Unknown';
  const state = task.state && task.state !== task.status ? ` (${promptField(task.state.replace(/_/g, ' '), 80)})` : '';
  const title = task.title ? ` "${promptField(task.title.replace(/"/g, "'"), 160)}"` : '';
  const session = projectId ? `, session \`${taskSessionName(projectId, task.task)}\`` : '';
  const prefix = `- \`${task.task}\`${title}${session}, ${status}${state}`;
  if (!task.files.length) return `${prefix}: no file changes yet`;
  // Keep overlaps visible even when this task has a large diff. Reserve space for the count.
  const files = [...task.files].sort((a, b) => Number(ownFiles.has(b)) - Number(ownFiles.has(a)));
  const shown: string[] = [];
  let used = prefix.length + 2;
  for (const file of files) {
    const item = `\`${file}\``;
    if (shown.length >= 30) break;
    // Keep shown paths exact; the omission count covers paths that do not fit.
    if (used + item.length + 2 > MAX_TASK_ROW_CHARS - 40) continue;
    shown.push(item);
    used += item.length + 2;
  }
  if (!shown.length) return `${prefix}: ${task.files.length} files omitted from this bounded snapshot`;
  const more = task.files.length > shown.length ? `, and ${task.files.length - shown.length} more files` : '';
  return `${prefix}: ${shown.join(', ')}${more}`;
}

/** Task messaging is on for the run: name each task's session, point at the live tools */
export interface ParallelTasksMessaging {
  projectId: string;
  /** The session has Workbench's `list_parallel_tasks` and `message_task` tools */
  tools: boolean;
  /** Project setting `mergeBaseDuring` (unset = validate) */
  mergeBaseDuring?: 'validate' | 'immediately';
}

/**
 * Prompt section about the project's other tasks: what they are changing right now and where
 * to look for newer entries. `specsDir` (the project's tasks folder) drops deleted tasks.
 * `promptPath` is the changelog's path as the session sees it (its WSL path when Claude Code runs there).
 */
export async function buildParallelTasksPrompt(
  changelogPath: string,
  specId: string,
  specsDir: string,
  promptPath: string = changelogPath,
  messaging?: ParallelTasksMessaging
): Promise<string> {
  const tasks = foldTaskChangelog(await readTaskChangelog(changelogPath));
  const ownFiles = new Set(tasks.get(specId)?.files ?? []);
  const activity = (task: TaskChangelogTask) => task.status === 'in_progress' || task.status === 'ai_review';
  const overlaps = (task: TaskChangelogTask) => task.files.some((file) => ownFiles.has(file));
  const others = [...tasks.values()].filter(
    (task) =>
      task.task !== specId &&
      task.status !== undefined &&
      ACTIVE_STATUSES.has(task.status) &&
      // merged by autonomous mode into the branch new tasks start from: not a parallel change any more
      task.state !== 'auto_merged' &&
      existsSync(path.join(specsDir, task.task))
  ).sort((a, b) =>
    Number(overlaps(b)) - Number(overlaps(a)) ||
    Number(activity(b)) - Number(activity(a)) ||
    Number(b.files.length > 0) - Number(a.files.length > 0) ||
    b.updatedAt.localeCompare(a.updatedAt) || a.task.localeCompare(b.task)
  );
  const fallback = 'Search recent changelog entries for the specific file paths or task IDs you need, limit output to 6,000 characters, and do not read the whole file.';
  const check = messaging?.tools
    ? `Before editing a file, check whether another task is changing it with \`list_parallel_tasks\` (the changelog is the fallback). Use its \`file\` filter for an exact repo-relative path or \`task\` filter for an id/title; follow \`nextOffset\` only when needed. ${fallback}`
    : `Before editing a file, check whether another task is changing it. ${fallback}`;
  const header = `## Parallel tasks
Other tasks of this project run in parallel in their own worktrees, and their branches are merged into the same base branch, so editing the same files causes merge conflicts. Workbench logs every task's states and the files it changes in \`${promptField(promptPath, 500)}\` (JSON Lines, newest last; don't modify it).
`;
  const footer = `
${check} Prefer approaches that leave those files alone; when the task needs them, keep those edits small and mention the overlap in your final summary.${messaging
    ? (messaging.mergeBaseDuring === 'immediately'
      ? ' When another task is merged into your base branch, a `[Workbench]` notice tells you to merge it into your branch: do it right away, as the notice says.'
      : ' When another task is merged into your base branch, a `[Workbench]` notice tells you so: do not merge it now, Workbench merges the base branch into your branch once, before validation (merge earlier only if you are blocked on that change).')
    : ''}`;
  let list = others.length
    ? 'Other tasks whose changes are not merged yet, as of now (known file overlaps, active tasks, then recent changes first):'
    : 'No other task has unmerged changes right now.';
  let shown = 0;
  // Reserve space for an omission notice even when the next row does not fit.
  const noticeReserve = `\n${others.length} additional unmerged tasks omitted from this bounded snapshot.`.length;
  for (const task of others) {
    const row = `\n${describeTask(task, ownFiles, messaging?.projectId)}`;
    if (header.length + list.length + row.length + footer.length + noticeReserve > PARALLEL_TASKS_PROMPT_MAX_CHARS) continue;
    list += row;
    shown++;
  }
  if (shown < others.length) list += `\n${others.length - shown} additional unmerged tasks omitted from this bounded snapshot.`;
  return `${header}${list}${footer}`;
}
