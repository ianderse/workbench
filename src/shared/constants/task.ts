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
// Note: pr_created maps to 'done' column in Kanban view (see KanbanBoard.tsx)
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

// Status colors for UI
// Note: pr_created maps to 'done' column in Kanban view (see KanbanBoard.tsx)
// Note: error maps to 'human_review' column in Kanban view (errors need human attention)
export const TASK_STATUS_COLORS: Record<TaskStatusColumn | 'pr_created' | 'error', string> = {
  backlog: 'bg-muted text-muted-foreground',
  queue: 'bg-cyan-500/10 text-cyan-400',
  in_progress: 'bg-info/10 text-info',
  ai_review: 'bg-warning/10 text-warning',
  human_review: 'bg-purple-500/10 text-purple-400',
  done: 'bg-success/10 text-success',
  pr_created: 'bg-info/10 text-info',
  error: 'bg-destructive/10 text-destructive'
};

/**
 * Kanban column a task is shown in: pr_created tasks sit in Done and error tasks in
 * Human Review (errors need human attention).
 */
export function getTaskColumn(status: TaskStatus): TaskStatusColumn {
  if (status === 'pr_created') return 'done';
  if (status === 'error') return 'human_review';
  return status;
}

/**
 * Columns a task may be moved to from each column, by drag and drop or the card's
 * "Move to" menu. Mirrors the task state machine (src/shared/state-machines/task-machine.ts),
 * which ignores other moves:
 * - Backlog: queue it or start it
 * - Queue: send it back to the backlog or start it
 * - In Progress: none (the task is running; stop it first)
 * - AI Review: stop validation and review it now
 * - Human Review (also failed tasks): queue it, resume it or mark it done
 * - Done: none (final)
 */
export const TASK_COLUMN_TRANSITIONS: Record<TaskStatusColumn, readonly TaskStatusColumn[]> = {
  backlog: ['queue', 'in_progress'],
  queue: ['backlog', 'in_progress'],
  in_progress: [],
  ai_review: ['human_review'],
  human_review: ['queue', 'in_progress', 'done'],
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
 * Maximum tasks in progress at once: the app setting (Settings > Terminal), otherwise a value a
 * project saved before the setting became app-wide, otherwise the default.
 */
export function resolveMaxParallelTasks(appValue?: number, projectValue?: number): number {
  return appValue ?? projectValue ?? DEFAULT_MAX_PARALLEL_TASKS;
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
// Subtask Status
// ============================================

export const SUBTASK_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-muted',
  in_progress: 'bg-info',
  completed: 'bg-success',
  failed: 'bg-destructive'
};

// ============================================
// Execution Phases
// ============================================

// Execution phase colors (for progress bars and indicators)
export const EXECUTION_PHASE_COLORS: Record<string, string> = {
  idle: 'bg-muted text-muted-foreground',
  planning: 'bg-amber-500 text-amber-50',
  coding: 'bg-info text-info-foreground',
  rate_limit_paused: 'bg-orange-500 text-orange-50',
  auth_failure_paused: 'bg-red-500 text-red-50',
  qa_review: 'bg-purple-500 text-purple-50',
  qa_fixing: 'bg-warning text-warning-foreground',
  complete: 'bg-success text-success-foreground',
  failed: 'bg-destructive text-destructive-foreground'
};

// Execution phase progress weights (for overall progress calculation)
export const EXECUTION_PHASE_WEIGHTS: Record<string, { start: number; end: number }> = {
  idle: { start: 0, end: 0 },
  planning: { start: 0, end: 20 },
  coding: { start: 20, end: 80 },
  rate_limit_paused: { start: 20, end: 80 },  // Same as coding (pause during coding)
  auth_failure_paused: { start: 20, end: 80 },  // Same as coding (pause during coding)
  qa_review: { start: 80, end: 95 },
  qa_fixing: { start: 80, end: 95 },  // Same range as qa_review, cycles back
  complete: { start: 100, end: 100 },
  failed: { start: 0, end: 0 }
};

// ============================================
// Image/Attachment Constants
// ============================================

// Maximum image file size (10 MB)
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

// Maximum number of images per task
export const MAX_IMAGES_PER_TASK = 10;

// Maximum number of referenced files per task
export const MAX_REFERENCED_FILES = 20;

// Allowed image MIME types
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp'
] as const;

// Allowed image file extensions (for display)
export const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

// Human-readable allowed types for error messages
export const ALLOWED_IMAGE_TYPES_DISPLAY = 'PNG, JPEG, GIF, WebP';

// Attachments directory name within spec folder
export const ATTACHMENTS_DIR = 'attachments';

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
