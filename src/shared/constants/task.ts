/**
 * Task-related constants
 * Includes status columns, parallelism limits, execution phases and attachment limits
 */

import type { TaskStatus } from '@shared/types/task';

// ============================================
// Task Status (Kanban columns)
// ============================================

// Task status columns in Kanban board order
export const TASK_STATUS_COLUMNS = [
  'backlog',
  'queue',
  'in_progress',
  'ai_review',
  'human_review',
  'done'
] as const;

export type TaskStatusColumn = typeof TASK_STATUS_COLUMNS[number];

// Status label translation keys (use with t() from react-i18next)
// Note: pr_created maps to 'human_review' column in Kanban view until its PR is merged
// Note: error maps to 'human_review' column in Kanban view (errors need human attention)
export const TASK_STATUS_LABELS: Record<TaskStatusColumn | 'pr_created' | 'error', string> = {
  backlog: 'columns.backlog',
  queue: 'columns.queue',
  in_progress: 'columns.in_progress',
  ai_review: 'columns.ai_review',
  human_review: 'columns.human_review',
  done: 'columns.done',
  pr_created: 'columns.pr_created',
  error: 'columns.error'
};

/**
 * Kanban column a task is shown in: pr_created tasks wait in Human Review until their PR is
 * merged (only merged tasks, or tasks moved there by hand, are Done), and so do error tasks
 * (errors need human attention).
 */
export function getTaskColumn(status: TaskStatus): TaskStatusColumn {
  if (status === 'pr_created' || status === 'error') return 'human_review';
  return status;
}

/**
 * Columns a task may be moved to from each column, by drag and drop or the card's
 * "Move to" menu. Mirrors the task state machine (src/shared/state-machines/task-machine.ts),
 * which ignores other moves:
 * - Backlog: queue it or start it
 * - Queue: send it back to the backlog or start it
 * - In Progress: none (the task is running; stop it first)
 * - AI Review: back to Planning, or stop validation and review it now
 * - Human Review (also failed tasks): back to Planning, queue it, resume it or mark it done
 * - Done: none (final)
 */
const TASK_COLUMN_TRANSITIONS: Record<TaskStatusColumn, readonly TaskStatusColumn[]> = {
  backlog: ['queue', 'in_progress'],
  queue: ['backlog', 'in_progress'],
  in_progress: [],
  ai_review: ['backlog', 'human_review'],
  human_review: ['backlog', 'queue', 'in_progress', 'done'],
  done: []
};

/** Columns a task with this status may be moved to (never its own column) */
export function getAllowedTaskMoves(status: TaskStatus): readonly TaskStatusColumn[] {
  return TASK_COLUMN_TRANSITIONS[getTaskColumn(status)];
}

/** Whether a task with status `from` may be moved to the `to` column */
export function canMoveTask(from: TaskStatus, to: TaskStatus): boolean {
  return getAllowedTaskMoves(from).includes(getTaskColumn(to));
}

/** Default max parallel tasks when no project setting is configured */
export const DEFAULT_MAX_PARALLEL_TASKS = 3;
export const MIN_PARALLEL_TASKS = 1;
export const MAX_PARALLEL_TASKS_LIMIT = 10;

/**
 * Maximum tasks running (in progress or in AI review) at once across ALL projects, which share
 * one model server: the app setting (Settings > Agents), else the default.
 */
export function resolveGlobalMaxParallelTasks(appValue?: number): number {
  return appValue ?? DEFAULT_MAX_PARALLEL_TASKS;
}

/** A project's own extra cap on its running tasks; undefined = only the global cap applies */
export function resolveProjectMaxParallelTasks(projectValue?: number): number | undefined {
  return typeof projectValue === 'number' && Number.isFinite(projectValue) && projectValue > 0 ? projectValue : undefined;
}

// Status priority for deduplication: higher = more complete
// Used in project-store.ts to resolve duplicate tasks (main vs worktree)
// IMPORTANT: Must follow workflow order: backlog < queue < in_progress < review < done
export const TASK_STATUS_PRIORITY: Record<TaskStatus, number> = {
  'done': 100,           // Highest priority - task is complete
  'pr_created': 90,
  'human_review': 80,
  'ai_review': 70,
  'in_progress': 50,
  'queue': 30,
  'backlog': 20,
  'error': 10           // Lowest priority
} as const;

// ============================================
// Image/Attachment Constants
// ============================================

// Maximum image file size (10 MB)
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// Maximum number of images per task
export const MAX_IMAGES_PER_TASK = 10;
// Allowed image MIME types
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp'
] as const;
// Human-readable allowed types for error messages
export const ALLOWED_IMAGE_TYPES_DISPLAY = 'PNG, JPEG, GIF, WebP';
// ============================================
// JSON Error Markers
// ============================================

/**
 * Marker prefix for task descriptions that failed JSON parsing.
 * Format: __JSON_ERROR__:<error message>
 * Used in project-store.ts when loading tasks with malformed implementation_plan.json
 */
export const JSON_ERROR_PREFIX = '__JSON_ERROR__:';

/**
 * Marker suffix for task titles that have JSON parsing errors.
 * Appended to spec directory name, replaced with i18n suffix at render time.
 * Used in project-store.ts when loading tasks with malformed implementation_plan.json
 */
export const JSON_ERROR_TITLE_SUFFIX = '__JSON_ERROR_SUFFIX__';
