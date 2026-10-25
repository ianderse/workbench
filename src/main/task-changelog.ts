/**
 * The project's task changelog: `.workbench/changelog.jsonl`, one JSON entry per line (oldest
 * first) for every state a task enters and the files its Claude Code session edits. Tasks run in
 * parallel in their own worktrees, so each task's prompt lists what the others are changing, and
 * they can re-read the file to avoid editing the same files (merge conflicts).
 *
 * This module reads the file and builds the prompt section; `task-changelog-writer.ts` writes it.
 */
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import type { TaskStatus } from '../shared/types';

export const TASK_CHANGELOG_FILE = 'changelog.jsonl';

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
      if (entry && typeof entry.task === 'string' && typeof entry.at === 'string') entries.push(entry);
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

function describeTask(task: TaskChangelogTask): string {
  const status = task.status ? STATUS_LABELS[task.status] : 'Unknown';
  const state = task.state && task.state !== task.status ? ` (${task.state.replace(/_/g, ' ')})` : '';
  const title = task.title ? ` "${task.title.replace(/"/g, "'")}"` : '';
  const shown = task.files.slice(0, 30);
  const more = task.files.length > shown.length ? `, and ${task.files.length - shown.length} more` : '';
  const files = shown.length ? `: ${shown.map((file) => `\`${file}\``).join(', ')}${more}` : ': no file changes yet';
  return `- \`${task.task}\`${title}, ${status}${state}${files}`;
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
  promptPath: string = changelogPath
): Promise<string> {
  const others = [...foldTaskChangelog(await readTaskChangelog(changelogPath)).values()].filter(
    (task) =>
      task.task !== specId &&
      task.status !== undefined &&
      ACTIVE_STATUSES.has(task.status) &&
      // merged by autonomous mode into the branch new tasks start from: not a parallel change any more
      task.state !== 'auto_merged' &&
      existsSync(path.join(specsDir, task.task))
  );
  const list = others.length
    ? `Other tasks whose changes are not merged yet, as of now:\n${others.map(describeTask).join('\n')}`
    : 'No other task has unmerged changes right now.';
  return `## Parallel tasks
Other tasks of this project run in parallel in their own worktrees, and their branches are merged into the same base branch, so editing the same files causes merge conflicts. Workbench logs every task's states and the files it changes in \`${promptPath}\` (JSON Lines, newest last; don't modify it).
${list}
Before editing a file, check whether another task is changing it (re-read the changelog for newer entries during long work). Prefer approaches that leave those files alone; when the task needs them, keep those edits small and mention the overlap in your final summary.`;
}
