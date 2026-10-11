/**
 * Plan File Utilities
 *
 * Provides thread-safe operations for reading and writing implementation_plan.json files.
 * Uses an in-memory lock to serialize updates and prevent race conditions when multiple
 * IPC handlers try to update the same plan file concurrently.
 *
 * IMPORTANT LIMITATION:
 * The synchronous function `persistPlanStatusSync` does NOT participate in the locking
 * mechanism. It bypasses the async lock entirely, which means:
 * - It can race with concurrent async operations (persistPlanStatus, updatePlanFile, etc.)
 * - It should ONLY be used when you are certain no async operations are pending on the same file
 * - Prefer using the async `persistPlanStatus` whenever possible
 *
 * If you need synchronous behavior, ensure that:
 * 1. No async plan operations are in flight for the same file path
 * 2. The calling context truly cannot use async/await (e.g., synchronous event handlers)
 */

import path from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { readdir, rm } from 'fs/promises';
import { AUTO_BUILD_PATHS, getSpecsDir } from '../../../shared/constants';
import type { TaskStatus, Project, Task, RateLimitHold, SubtaskStatus } from '../../../shared/types';
import { CLAUDE_RUN_FILE, resetClaudeRunInfo } from '../../claude-code/task-runner';
import { projectStore } from '../../project-store';
import type { TaskEventPayload } from '../../agent/task-event-schema';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { safeParseJson } from '../../utils/json-repair';

// In-memory locks for plan file operations
// Key: plan file path, Value: Promise chain for serializing operations
const planLocks = new Map<string, Promise<void>>();

/**
 * Serialize operations on a specific plan file to prevent race conditions.
 * Each operation waits for the previous one to complete before starting.
 */
async function withPlanLock<T>(planPath: string, operation: () => Promise<T>): Promise<T> {
  // Get or create the lock chain for this file
  const currentLock = planLocks.get(planPath) || Promise.resolve();

  // Create a new promise that will resolve after our operation completes
  let resolve: () => void;
  const newLock = new Promise<void>((r) => { resolve = r; });
  planLocks.set(planPath, newLock);

  try {
    // Wait for any previous operation to complete
    await currentLock;
    // Execute our operation
    return await operation();
  } finally {
    // Release the lock
    resolve!();
    // Clean up if this was the last operation
    if (planLocks.get(planPath) === newLock) {
      planLocks.delete(planPath);
    }
  }
}

/**
 * Check if an error is a "file not found" error
 */
function isFileNotFoundError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Get the plan file path for a task
 */
export function getPlanPath(project: Project, task: Task): string {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  const specDir = path.join(project.path, specsBaseDir, task.specId);
  return path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
}

/**
 * Map UI TaskStatus to Python-compatible planStatus
 */
function mapStatusToPlanStatus(status: TaskStatus): string {
  switch (status) {
    case 'queue':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'ai_review':
    case 'human_review':
      return 'review';
    case 'done':
      return 'completed';
    default:
      return 'pending';
  }
}

/**
 * Persist task status to implementation_plan.json file.
 * This is thread-safe and prevents race conditions when multiple handlers update the same file.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param status - The TaskStatus to persist
 * @param projectId - Optional project ID to invalidate cache (recommended for performance)
 * @returns true if status was persisted, false if plan file doesn't exist
 */
export async function persistPlanStatus(planPath: string, status: TaskStatus, projectId?: string): Promise<boolean> {
  return withPlanLock(planPath, async () => {
    try {
      console.warn(`[plan-file-utils] Reading implementation_plan.json to update status to: ${status}`, { planPath });
      // Read file directly without existence check to avoid TOCTOU race condition
      const planContent = readFileSync(planPath, 'utf-8');
      const plan = safeParseJson<Record<string, unknown>>(planContent);
      if (!plan) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - status not persisted`);
        return false;
      }

      plan.status = status;
      plan.planStatus = mapStatusToPlanStatus(status);
      plan.updated_at = new Date().toISOString();

      writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
      console.warn(`[plan-file-utils] Successfully persisted status: ${status} to implementation_plan.json`);

      // Invalidate tasks cache since status changed
      if (projectId) {
        projectStore.invalidateTasksCache(projectId);
      }

      return true;
    } catch (err) {
      // File not found is expected - return false
      if (isFileNotFoundError(err)) {
        console.warn(`[plan-file-utils] implementation_plan.json not found at ${planPath} - status not persisted`);
        return false;
      }
      console.warn(`[plan-file-utils] Could not persist status to ${planPath}:`, err);
      return false;
    }
  });
}

/**
 * Persist lastEvent metadata synchronously.
 *
 * WARNING: This bypasses async locking. Use only in sync event handlers where
 * async isn't practical. Prefer updatePlanFile when possible.
 */
export function persistPlanLastEventSync(planPath: string, event: TaskEventPayload): boolean {
  try {
    const planContent = readFileSync(planPath, 'utf-8');
    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) {
      console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - lastEvent not persisted`);
      return false;
    }

    plan.lastEvent = {
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp
    };
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not persist lastEvent to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist task status, reviewReason, XState state, and execution phase synchronously.
 * The xstateState and executionPhase are used to restore the exact machine state on reload,
 * distinguishing between e.g. 'planning' vs 'coding' when both have status 'in_progress'.
 *
 * If the plan file doesn't exist, creates a minimal plan with the status fields.
 * This ensures XState state is persisted even during early phases like spec creation.
 */
export function persistPlanStatusAndReasonSync(
  planPath: string,
  status: TaskStatus,
  reviewReason?: string,
  projectId?: string,
  xstateState?: string,
  executionPhase?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    try {
      const planContent = readFileSync(planPath, 'utf-8');
      const parsed = safeParseJson<Record<string, unknown>>(planContent);
      if (!parsed) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - status/reason not persisted`);
        return false;
      }
      plan = parsed;
    } catch (readErr) {
      if (!isFileNotFoundError(readErr)) {
        throw readErr;
      }
      // File doesn't exist - create a minimal plan with just status fields
      // The spec runner will populate the full plan later
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = {
        created_at: new Date().toISOString(),
        phases: []
      };
      console.log(`[plan-file-utils] Creating minimal plan for XState persistence: ${planPath}`);
    }

    plan.status = status;
    plan.planStatus = mapStatusToPlanStatus(status);
    plan.reviewReason = reviewReason;
    if (xstateState) {
      plan.xstateState = xstateState;
    }
    if (executionPhase) {
      plan.executionPhase = executionPhase;
    }
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist status/reason to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist (or clear, when `hold` is null) the rate-limit hold on a plan file synchronously.
 *
 * WARNING: Bypasses async locking (same caveats as persistPlanStatusSync).
 *
 * @returns true if written, false if the plan file is missing or unreadable
 */
export function persistPlanRateLimitHoldSync(
  planPath: string,
  hold: RateLimitHold | null,
  projectId?: string
): boolean {
  try {
    const planContent = readFileSync(planPath, 'utf-8');
    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) {
      console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - rate-limit hold not persisted`);
      return false;
    }
    if (!hold && plan.rateLimitHold === undefined) {
      return true; // Nothing to clear
    }

    if (hold) {
      plan.rateLimitHold = hold;
    } else {
      delete plan.rateLimitHold;
    }
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }
    return true;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return false;
    }
    console.warn(`[plan-file-utils] Could not persist rate-limit hold to ${planPath}:`, err);
    return false;
  }
}

/**
 * Persist execution phase to the plan file synchronously.
 * This is called when execution progress updates to ensure the phase
 * is persisted for restoration on app refresh.
 */
export function persistPlanPhaseSync(
  planPath: string,
  phase: string,
  projectId?: string
): boolean {
  try {
    let plan: Record<string, unknown>;

    try {
      const planContent = readFileSync(planPath, 'utf-8');
      const parsed = safeParseJson<Record<string, unknown>>(planContent);
      if (!parsed) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - phase not persisted`);
        return false;
      }
      plan = parsed;
    } catch (readErr) {
      if (!isFileNotFoundError(readErr)) {
        throw readErr;
      }
      // File doesn't exist - create minimal plan
      const planDir = path.dirname(planPath);
      mkdirSync(planDir, { recursive: true });
      plan = {
        created_at: new Date().toISOString(),
        phases: []
      };
    }

    // Store the execution phase for restoration
    plan.executionPhase = phase;

    // Also update status to match the phase so the card stays in the correct column on refresh
    // Map execution phase to TaskStatus for column placement
    const phaseToStatus: Record<string, TaskStatus> = {
      'planning': 'in_progress',
      'coding': 'in_progress',
      'qa_review': 'ai_review',
      'qa_fixing': 'ai_review',
      'complete': 'human_review',
      'failed': 'error'
    };
    const mappedStatus = phaseToStatus[phase];
    if (mappedStatus) {
      plan.status = mappedStatus;
      plan.planStatus = mapStatusToPlanStatus(mappedStatus);
    }

    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));

    if (projectId) {
      projectStore.invalidateTasksCache(projectId);
    }

    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not persist phase to ${planPath}:`, err);
    return false;
  }
}

/**
 * Create a new plan file if it doesn't exist.
 *
 * @param planPath - Path to the implementation_plan.json file
 * @param task - The task to create the plan for
 * @param status - Initial status for the plan
 * @param xstateState - Optional XState machine state for restoration
 */
export async function createPlanIfNotExists(
  planPath: string,
  task: Task,
  status: TaskStatus,
  xstateState?: string
): Promise<void> {
  return withPlanLock(planPath, async () => {
    // Try to read the file first - if it exists, do nothing
    try {
      readFileSync(planPath, 'utf-8');
      return; // File exists, nothing to do
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        throw err; // Re-throw unexpected errors
      }
      // File doesn't exist, continue to create it
    }

    const plan: Record<string, unknown> = {
      feature: task.title,
      description: task.description || '',
      created_at: task.createdAt.toISOString(),
      updated_at: new Date().toISOString(),
      status: status,
      planStatus: mapStatusToPlanStatus(status),
      phases: []
    };

    // Include xstateState for accurate restoration on reload
    if (xstateState) {
      plan.xstateState = xstateState;
    }

    // Ensure directory exists - use try/catch pattern
    const planDir = path.dirname(planPath);
    try {
      mkdirSync(planDir, { recursive: true });
    } catch (err) {
      // Directory might already exist or be created concurrently - that's fine
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
  });
}

/**
 * The implementation_plan.json a task starts with (written by TASK_CREATE): no phases, not
 * started. `createdAt` keeps the task's original creation time when resetting it.
 */
export function buildInitialPlan(
  title: string,
  description: string,
  createdAt?: string
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    feature: title,
    description,
    created_at: createdAt || now,
    updated_at: now,
    status: 'pending',
    phases: []
  };
}

/**
 * Spec dir entries created with the task (TASK_CREATE). Everything else in a spec dir is
 * generated by runs (claude_run.json, task_logs.json, plan.md, reports, feedback images,
 * session logs, old pipeline files) and is removed when the task is reset.
 */
const INITIAL_SPEC_ENTRIES = new Set<string>([
  'task_metadata.json',
  'attachments',
  AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
]);

/**
 * Reset a task's spec dir to the state TASK_CREATE left it in: keeps task_metadata.json and
 * attachments/, removes every other entry and rewrites implementation_plan.json as a fresh
 * plan (original created_at kept). With `status: 'queue'` the plan is written queued.
 */
export async function resetSpecDirToInitialState(
  specDir: string,
  task: { title: string; description?: string },
  options?: { status?: 'backlog' | 'queue' }
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(specDir);
  } catch (err) {
    if (!isFileNotFoundError(err)) throw err;
    mkdirSync(specDir, { recursive: true });
  }

  const planPath = path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
  await withPlanLock(planPath, async () => {
    for (const entry of entries) {
      if (INITIAL_SPEC_ENTRIES.has(entry)) continue;
      await rm(path.join(specDir, entry), { recursive: true, force: true });
    }

    let createdAt: string | undefined;
    try {
      const previous = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
      if (typeof previous?.created_at === 'string') createdAt = previous.created_at;
    } catch {
      // Missing or unreadable plan: start with a new one
    }

    const plan = buildInitialPlan(task.title, task.description || '', createdAt);
    if (options?.status === 'queue') {
      plan.status = 'queue';
      plan.planStatus = mapStatusToPlanStatus('queue');
    }
    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
  });
}

/**
 * Start a task over: reset its spec dir to the initial state (see resetSpecDirToInitialState).
 * The caller removes the task's worktree first (the worktree copy of the spec dir goes with it).
 */
export async function resetTaskToInitialState(
  project: Project,
  task: Task,
  options?: { status?: 'backlog' | 'queue' }
): Promise<void> {
  const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
  await resetSpecDirToInitialState(specDir, task, options);
  projectStore.invalidateTasksCache(project.id);
}

/**
 * Update task_metadata.json to add PR URL.
 * This is a simple JSON file update (no locking needed as it's rarely updated concurrently).
 *
 * @param metadataPath - Path to the task_metadata.json file
 * @param prUrl - The PR URL to add to metadata
 * @returns true if metadata was updated, false if file doesn't exist or failed
 */
export function updateTaskMetadataPrUrl(metadataPath: string, prUrl: string): boolean {
  try {
    let metadata: Record<string, unknown> = {};

    // Try to read existing metadata
    try {
      const content = readFileSync(metadataPath, 'utf-8');
      metadata = safeParseJson<Record<string, unknown>>(content) || {};
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        throw err;
      }
      // File doesn't exist, will create new one
    }

    // Update with prUrl
    metadata.prUrl = prUrl;

    // Ensure parent directory exists before writing
    mkdirSync(path.dirname(metadataPath), { recursive: true });

    // Write back
    writeFileAtomicSync(metadataPath, JSON.stringify(metadata, null, 2));
    return true;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not update metadata at ${metadataPath}:`, err);
    return false;
  }
}

/** Name of the plan phase that mirrors Claude Code's task list */
const CLAUDE_TASK_LIST_PHASE_NAME = 'Claude Code task list';

/**
 * Mirror Claude Code's task list (TaskCreate/TaskUpdate) as the task's subtasks: one phase
 * in implementation_plan.json. Preserves every other field of the plan.
 *
 * @returns the updated plan, or null if it couldn't be written
 */
export function writePlanSubtasksSync(
  planPath: string,
  subtasks: Array<{ id: string; title: string; description: string; status: SubtaskStatus }>,
  projectId?: string
): Record<string, unknown> | null {
  try {
    let plan: Record<string, unknown>;
    try {
      const parsed = safeParseJson<Record<string, unknown>>(readFileSync(planPath, 'utf-8'));
      if (!parsed) {
        console.warn(`[plan-file-utils] Unrepairable JSON in ${planPath} - subtasks not written`);
        return null;
      }
      plan = parsed;
    } catch (readErr) {
      if (!isFileNotFoundError(readErr)) throw readErr;
      mkdirSync(path.dirname(planPath), { recursive: true });
      plan = { created_at: new Date().toISOString() };
    }

    plan.phases = subtasks.length > 0
      ? [{
          phase: 1,
          name: CLAUDE_TASK_LIST_PHASE_NAME,
          type: 'implementation',
          subtasks: subtasks.map((s) => ({
            id: s.id,
            title: s.title,
            description: s.description || s.title,
            status: s.status,
          })),
        }]
      : [];
    plan.updated_at = new Date().toISOString();

    writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
    if (projectId) projectStore.invalidateTasksCache(projectId);
    return plan;
  } catch (err) {
    console.warn(`[plan-file-utils] Could not write subtasks to ${planPath}:`, err);
    return null;
  }
}

/**
 * Forget a task's Claude Code run so the next start triages and runs from scratch:
 * resets claude_run.json and clears the mirrored subtasks. Call it when the task's
 * worktree is discarded.
 */
export function resetTaskRunState(project: Project, task: Task): void {
  const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
  if (existsSync(path.join(specDir, CLAUDE_RUN_FILE))) {
    resetClaudeRunInfo(specDir);
  }
  const planPath = getPlanPath(project, task);
  if (existsSync(planPath)) {
    writePlanSubtasksSync(planPath, [], project.id);
  }
  projectStore.invalidateTasksCache(project.id);
}

/**
 * Whether a task's run got past planning: Claude Code started implementing (claude_run.json)
 * or the plan has subtasks. Used to decide where a stopped task goes (backlog vs review).
 */
export function hasStartedImplementation(project: Project, task: Task): boolean {
  if (hasPlanWithSubtasks(project, task)) return true;
  const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
  try {
    const info = safeParseJson<{ phases?: Array<{ name?: string }> }>(
      readFileSync(path.join(specDir, CLAUDE_RUN_FILE), 'utf-8')
    );
    return !!info?.phases?.some((p) => p.name === 'implement' || p.name === 'revise');
  } catch {
    return false;
  }
}

/**
 * Check if a task has a valid implementation plan with subtasks.
 * A plan is considered valid if it has at least one subtask across all phases.
 *
 * @param project - The project containing the task
 * @param task - The task to check
 * @returns true if the task has a valid plan with subtasks, false otherwise
 */
function hasPlanWithSubtasks(project: Project, task: Task): boolean {
  try {
    const planPath = getPlanPath(project, task);
    const planContent = readFileSync(planPath, 'utf-8');
    if (!planContent) {
      return false;
    }

    const plan = safeParseJson<Record<string, unknown>>(planContent);
    if (!plan) return false;
    // A plan exists if it has phases with subtasks (totalCount > 0)
    const phases = plan.phases as Array<{ subtasks?: Array<unknown> }> | undefined;
    const totalCount = phases?.flatMap(p => p.subtasks || []).length || 0;
    return totalCount > 0;
  } catch {
    // File doesn't exist or is malformed
    return false;
  }
}
