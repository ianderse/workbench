/**
 * Autonomous mode: the service
 * ============================
 *
 * Ties the pure rules (`shared/utils/autonomous.ts`) and the git operations
 * (`autonomous-git.ts`) to the app: merges a task that passed AI review into the target branch,
 * records it on the task, moves the task to Human Review as `auto_merged`, starts the queue and
 * grooms it, and offers revert / merge-into-base / follow-up tasks.
 *
 * Every step is logged to appLog and to the task's log. Nothing here throws into the caller: a
 * merge that cannot happen leaves the task in Human Review with `metadata.autoMergeBlocked`.
 */
import path from 'path';
import type { Project, Task } from '../../shared/types';
import type {
  AutonomousMergeIntoBaseResult,
  AutonomousRevertPreview,
  AutonomousRevertResult,
  AutonomousStatus,
} from '../../shared/types/autonomous';
import { getSpecsDir } from '../../shared/constants';
import {
  ANY_TARGET_BRANCH,
  activeAutoMerge,
  decideAutoMerge,
  findAutoMergedDependents,
  getAutonomousTargetBranch,
  resolveAutonomousConfig,
} from '../../shared/utils/autonomous';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { taskStateManager } from '../task-state-manager';
import { taskQueue } from '../services/task-queue';
import { groomQueueAfterMerge } from '../queue-grooming';
import { findTaskWorktree } from '../worktree-paths';
import { resolveDefaultBaseBranch } from '../utils/base-branch';
import { TaskLogWriter } from '../claude-code/task-log';
import { persistPlanStatusAndReasonSync, updateTaskMetadataFields, getPlanPath } from '../ipc-handlers/task/plan-file-utils';
import {
  autoMergeIntoTarget,
  countTasksAhead,
  ensureIntegrationBranch,
  localBranchSha,
  mergeIntegrationIntoBase,
  pushBranch,
  revertMergeOnTarget,
  type AutoMergeInput,
} from './autonomous-git';

let notifyChanged: (projectId: string) => void = () => undefined;

/** Called once at startup with the function that tells the board to reload */
export function configureAutonomous(notify: (projectId: string) => void): void {
  notifyChanged = notify;
}

// -----------------------------------------------------------------------------
// Target branch
// -----------------------------------------------------------------------------

function explicitBaseBranch(project: Project, task: Pick<Task, 'metadata'>): string | undefined {
  const branch = task.metadata?.baseBranch;
  const chosen = branch && branch !== '__project_default__' ? branch.replace(/^origin\//, '') : undefined;
  return chosen || project.settings?.mainBranch || undefined;
}

/**
 * The branch a queued task will branch from while autonomous mode is on (undefined when it is
 * off). Synchronous, for the queue gate: a project that merges into its default base branch and
 * names none matches any branch.
 */
export function getAutonomousTargetSync(project: Project | undefined, task: Pick<Task, 'metadata'>): string | undefined {
  if (!project) return undefined;
  const config = resolveAutonomousConfig(project.settings);
  return getAutonomousTargetBranch(config, explicitBaseBranch(project, task) ?? ANY_TARGET_BRANCH);
}

/** The project's base branch: the chosen one, else the repository's default */
export async function resolveProjectBaseBranch(project: Project, task?: Pick<Task, 'metadata'>): Promise<string> {
  return (task ? explicitBaseBranch(project, task) : project.settings?.mainBranch) || (await resolveDefaultBaseBranch(project.path));
}

/** The branch tasks of this project start from and merge into (undefined while autonomous mode is off) */
export async function resolveAutonomousTarget(project: Project, task?: Pick<Task, 'metadata'>): Promise<string | undefined> {
  const config = resolveAutonomousConfig(project.settings);
  if (!config.enabled) return undefined;
  if (config.target === 'integration') return config.integrationBranch;
  return resolveProjectBaseBranch(project, task);
}

/**
 * For a task about to get its worktree: the branch to cut it from when autonomous mode is on,
 * creating the integration branch from the base branch when it does not exist yet
 */
export async function prepareAutonomousBase(project: Project, task: Pick<Task, 'metadata'>): Promise<string | undefined> {
  const config = resolveAutonomousConfig(project.settings);
  if (!config.enabled || config.target !== 'integration') return undefined;
  const base = await resolveProjectBaseBranch(project, task);
  const { created } = await ensureIntegrationBranch(project.path, config.integrationBranch, base);
  if (created) appLog.info(`[Autonomous] Created ${config.integrationBranch} from ${base} in ${project.path}`);
  return config.integrationBranch;
}

// -----------------------------------------------------------------------------
// Logging and task files
// -----------------------------------------------------------------------------

function specDirOf(project: Project, task: Pick<Task, 'specId'>): string {
  return path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
}

/** appLog plus a line in the task's log */
function logTask(project: Project, task: Task, level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[Autonomous] ${task.id}: ${message}`;
  if (level === 'info') appLog.info(line);
  else if (level === 'warn') appLog.warn(line);
  else appLog.error(line);
  try {
    const writer = new TaskLogWriter(specDirOf(project, task), task.specId);
    writer.add('validation', level === 'error' ? 'error' : 'info', `Autonomous mode: ${message}`);
    writer.saveNow();
  } catch (error) {
    appLog.warn('[Autonomous] Could not write to the task log:', error);
  }
}

/** Set fields of the task's metadata in the project and in its worktree (undefined removes a field) */
function writeMetadata(project: Project, task: Task, fields: Record<string, unknown>): void {
  const specsBaseDir = getSpecsDir(project.autoBuildPath);
  updateTaskMetadataFields(path.join(project.path, specsBaseDir, task.specId, 'task_metadata.json'), fields);
  const worktree = findTaskWorktree(project.path, task.specId);
  if (worktree) updateTaskMetadataFields(path.join(worktree, specsBaseDir, task.specId, 'task_metadata.json'), fields);
  projectStore.invalidateTasksCache(project.id);
}

function freshTask(projectId: string, taskId: string): Task | undefined {
  projectStore.invalidateTasksCache(projectId);
  return projectStore.getTasks(projectId).find((t) => t.id === taskId || t.specId === taskId);
}

// -----------------------------------------------------------------------------
// Serialization: one merge at a time per project
// -----------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>();

function serialized<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(projectId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(projectId, tail);
  void tail.then(() => {
    if (chains.get(projectId) === tail) chains.delete(projectId);
  });
  return run;
}

/** Tasks whose automatic merge is queued or running */
const inFlight = new Set<string>();

// -----------------------------------------------------------------------------
// Auto-merge
// -----------------------------------------------------------------------------

export interface AutoMergeDeps {
  /** Replaces the merge agent (tests) */
  mergeAgent?: AutoMergeInput['mergeAgent'];
}

/**
 * A task just reached Human Review: merge it into the target branch when autonomous mode is on
 * and it passed the AI review. Safe to call for every task entering Human Review.
 */
export async function maybeAutoMerge(projectIn: Project, taskIn: Pick<Task, 'id'>, deps: AutoMergeDeps = {}): Promise<void> {
  const project = projectStore.getProject(projectIn.id) ?? projectIn;
  const config = resolveAutonomousConfig(project.settings);
  if (!config.enabled) return;
  // A Spec review ticket changes no code: there is nothing to merge
  if (projectStore.getTasks(project.id).find((t) => t.id === taskIn.id)?.metadata?.specReview) return;
  const key = `${project.id}\0${taskIn.id}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const task = freshTask(project.id, taskIn.id);
    if (!task) return;
    // A merge that was blocked stays blocked until the task runs again (the flag is cleared then)
    if (task.metadata?.autoMergeBlocked) return;
    const decision = decideAutoMerge(config, {
      status: task.status,
      reviewReason: task.reviewReason,
      verdictStatus: task.claudeRun?.reviewVerdict?.status,
      alreadyMerged: !!activeAutoMerge(task),
    });
    if (!decision.eligible) {
      // Only a task that finished its run deserves a line in its log
      if (task.status === 'human_review' && task.reviewReason === 'completed') {
        logTask(project, task, 'info', `not merged automatically: ${decision.reason}`);
      }
      return;
    }
    await serialized(project.id, () => runAutoMerge(project, task, deps));
  } catch (error) {
    appLog.error(`[Autonomous] Auto-merge of ${taskIn.id} failed unexpectedly:`, error);
  } finally {
    inFlight.delete(key);
  }
}

/** The task runs again (request changes, resume): a new review may pass, so its blocked merge is forgotten */
export function clearAutoMergeBlocked(project: Project, task: Task): void {
  if (!task.metadata?.autoMergeBlocked) return;
  writeMetadata(project, task, { autoMergeBlocked: undefined });
  notifyChanged(project.id);
}

async function blockAutoMerge(project: Project, task: Task, reason: 'conflicts' | 'dirty_target' | 'error', message: string): Promise<void> {
  const text = reason === 'conflicts' ? `Auto-merge blocked: conflicts. ${message}` : `Auto-merge blocked: ${message}`;
  // (the board shows a translated line for the reason; the full text is its tooltip)
  logTask(project, task, 'warn', text);
  writeMetadata(project, task, { autoMergeBlocked: { reason, message: text, at: new Date().toISOString() } });
  notifyChanged(project.id);
}

async function runAutoMerge(project: Project, task: Task, deps: AutoMergeDeps): Promise<void> {
  const config = resolveAutonomousConfig(project.settings);
  logTask(project, task, 'info', 'AI review passed, merging into the target branch');

  const worktreePath = findTaskWorktree(project.path, task.specId);
  if (!worktreePath) return blockAutoMerge(project, task, 'error', "the task's worktree is gone");

  let targetBranch: string;
  try {
    if (config.target === 'integration') {
      const base = await resolveProjectBaseBranch(project, task);
      await ensureIntegrationBranch(project.path, config.integrationBranch, base);
      targetBranch = config.integrationBranch;
    } else {
      targetBranch = await resolveProjectBaseBranch(project, task);
    }
  } catch (error) {
    return blockAutoMerge(project, task, 'error', error instanceof Error ? error.message : String(error));
  }

  const result = await autoMergeIntoTarget({
    projectDir: project.path,
    worktreePath,
    targetBranch,
    taskTitle: task.title,
    taskDescription: task.description,
    specId: task.specId,
    dataDir: project.autoBuildPath,
    profileId: project.settings?.claudeProfileId,
    mergeAgent: deps.mergeAgent,
    log: (message) => logTask(project, task, 'info', message),
    shouldContinue: () => {
      // The user may have moved the task while a conflict was being resolved
      const current = freshTask(project.id, task.id);
      return !!current && current.status === 'human_review' && current.reviewReason === 'completed';
    },
  });

  if (!result.success) return blockAutoMerge(project, task, result.kind, result.message);

  let pushed: boolean | undefined;
  let pushError: string | undefined;
  if (config.push) {
    const push = await pushBranch(project.path, targetBranch);
    pushed = push.pushed;
    if (push.skipped) logTask(project, task, 'info', 'no remote to push to');
    else if (push.error) {
      pushError = push.error;
      logTask(project, task, 'warn', `could not push ${targetBranch}: ${push.error}`);
    } else logTask(project, task, 'info', `pushed ${targetBranch}`);
  }

  writeMetadata(project, task, {
    autoMerge: {
      sha: result.sha,
      branch: targetBranch,
      at: new Date().toISOString(),
      ...(pushed !== undefined ? { pushed } : {}),
      ...(pushError ? { pushError } : {}),
    },
    autoMergeBlocked: undefined,
  });
  logTask(project, task, 'info', `merged into ${targetBranch} (${result.sha.slice(0, 8)}), waiting for your review`);

  // Human Review with the new reason; the plan file is the fallback when the machine is elsewhere
  const merged = freshTask(project.id, task.id) ?? task;
  taskStateManager.handleUiEvent(task.id, { type: 'AUTO_MERGED' }, merged, project);
  if (taskStateManager.getCurrentState(task.id, project.id) !== 'auto_merged') {
    persistPlanStatusAndReasonSync(getPlanPath(project, task), 'human_review', 'auto_merged', project.id, 'auto_merged', 'complete');
  }
  projectStore.invalidateTasksCache(project.id);
  notifyChanged(project.id);

  // The tasks waiting on this one can start, and the queue is groomed with structural changes applied
  taskQueue.request(project.id);
  void groomQueueAfterMerge(project.id, task.id, { autoApplyStructural: true }).catch((error) => {
    appLog.warn('[Autonomous] Queue grooming failed:', error);
  });
}

// -----------------------------------------------------------------------------
// Revert
// -----------------------------------------------------------------------------

export function previewRevert(project: Project, task: Task): AutonomousRevertPreview {
  const tasks = projectStore.getTasks(project.id);
  return { dependents: findAutoMergedDependents(task, tasks).map((t) => ({ id: t.id, title: t.title })) };
}

/** `git revert -m 1` of the task's merge commit on its target branch, in a temporary worktree */
export async function revertAutoMerge(project: Project, task: Task): Promise<{ success: true; data: AutonomousRevertResult } | { success: false; error: string }> {
  const record = activeAutoMerge(task);
  if (!record) return { success: false, error: 'This task has no automatic merge to revert' };
  const config = resolveAutonomousConfig(project.settings);
  return serialized(project.id, async () => {
    logTask(project, task, 'info', `reverting ${record.sha.slice(0, 8)} on ${record.branch}`);
    const result = await revertMergeOnTarget(project.path, record.branch, record.sha);
    if (!result.success) {
      const files = result.conflictedFiles?.length ? ` (${result.conflictedFiles.join(', ')})` : '';
      logTask(project, task, 'warn', `revert failed: ${result.message}${files}`);
      return { success: false as const, error: `${result.message}${files}` };
    }
    let pushed: boolean | undefined;
    let pushError: string | undefined;
    if (config.push) {
      const push = await pushBranch(project.path, record.branch);
      pushed = push.pushed;
      if (push.error) {
        pushError = push.error;
        logTask(project, task, 'warn', `could not push ${record.branch}: ${push.error}`);
      }
    }
    writeMetadata(project, task, { autoMerge: { ...record, revertedAt: new Date().toISOString(), revertSha: result.sha } });
    logTask(project, task, 'info', `reverted on ${record.branch} (${result.sha.slice(0, 8)})`);
    const fresh = freshTask(project.id, task.id) ?? task;
    taskStateManager.handleUiEvent(task.id, { type: 'AUTO_MERGE_REVERTED' }, fresh, project);
    if (taskStateManager.getCurrentState(task.id, project.id) !== 'human_review') {
      persistPlanStatusAndReasonSync(getPlanPath(project, task), 'human_review', 'completed', project.id, 'human_review', 'complete');
    }
    projectStore.invalidateTasksCache(project.id);
    notifyChanged(project.id);
    taskQueue.request(project.id);
    return { success: true as const, data: { sha: result.sha, ...(pushed !== undefined ? { pushed } : {}), ...(pushError ? { pushError } : {}) } };
  });
}

// -----------------------------------------------------------------------------
// Finish line: integration branch into the base branch
// -----------------------------------------------------------------------------

export async function getAutonomousStatus(project: Project): Promise<AutonomousStatus | null> {
  const config = resolveAutonomousConfig(project.settings);
  if (!config.enabled) return null;
  let baseBranch: string;
  try {
    baseBranch = await resolveProjectBaseBranch(project);
  } catch {
    baseBranch = project.settings?.mainBranch || 'main';
  }
  const branch = getAutonomousTargetBranch(config, baseBranch) ?? config.integrationBranch;
  const branchExists = (await localBranchSha(project.path, branch)) !== null;
  const ahead = config.target === 'integration' && branchExists ? await countTasksAhead(project.path, branch, baseBranch) : 0;
  return { enabled: true, target: config.target, branch, baseBranch, branchExists, ahead, push: config.push };
}

export async function mergeIntegrationIntoMain(project: Project): Promise<{ success: true; data: AutonomousMergeIntoBaseResult } | { success: false; error: string }> {
  const config = resolveAutonomousConfig(project.settings);
  if (!config.enabled || config.target !== 'integration') return { success: false, error: 'Autonomous mode does not use an integration branch' };
  return serialized(project.id, async () => {
    const baseBranch = await resolveProjectBaseBranch(project).catch(() => project.settings?.mainBranch || 'main');
    appLog.info(`[Autonomous] Merging ${config.integrationBranch} into ${baseBranch} in ${project.path}`);
    const result = await mergeIntegrationIntoBase(project.path, config.integrationBranch, baseBranch);
    if (!result.success) {
      appLog.warn(`[Autonomous] Merge of ${config.integrationBranch} into ${baseBranch} failed: ${result.message}`);
      const files = result.conflictedFiles?.length ? ` (${result.conflictedFiles.join(', ')})` : '';
      return { success: false as const, error: `${result.message}${files}` };
    }
    if (result.alreadyUpToDate) return { success: true as const, data: { merged: false, alreadyUpToDate: true, sha: result.sha } };
    let pushed: boolean | undefined;
    let pushError: string | undefined;
    if (config.push) {
      const push = await pushBranch(project.path, baseBranch);
      pushed = push.pushed;
      if (push.error) {
        pushError = push.error;
        appLog.warn(`[Autonomous] Could not push ${baseBranch}: ${push.error}`);
      }
      if (result.integrationUpdated) {
        const pushIntegration = await pushBranch(project.path, config.integrationBranch);
        if (pushIntegration.error) appLog.warn(`[Autonomous] Could not push ${config.integrationBranch}: ${pushIntegration.error}`);
      }
    }
    notifyChanged(project.id);
    return {
      success: true as const,
      data: { merged: true, sha: result.sha, ...(pushed !== undefined ? { pushed } : {}), ...(pushError ? { pushError } : {}) },
    };
  });
}

// -----------------------------------------------------------------------------
// Request changes on an automatically merged task
// -----------------------------------------------------------------------------

/**
 * "Request changes" on a task that is already merged cannot continue its old worktree: that
 * branch is behind the target branch (other tasks merged since) and its session predates them. A
 * new task starts from the target branch as it is now and carries the reviewer's feedback; it goes
 * to the top of the Queue and depends on nothing (the original is merged already).
 */
export async function createFollowUpTask(
  project: Project,
  task: Task,
  feedback: string | undefined,
  images: Array<Record<string, unknown>> | undefined
): Promise<{ success: true; taskId: string } | { success: false; error: string }> {
  const record = task.metadata?.autoMerge;
  const text = feedback?.trim();
  const description = [
    `Follow-up to "${task.title}" (${task.id}), which autonomous mode merged into ${record?.branch ?? 'the target branch'}${record ? ` as ${record.sha.slice(0, 8)}` : ''}.`,
    text ? `The reviewer asked for these changes:\n\n${text}` : 'The reviewer attached images with the requested changes.',
    'The original change is already in your starting branch. Fix only what the reviewer described; do not redo the original task.',
  ].join('\n\n');
  try {
    const { invokeIpcHandler } = await import('../ipc-handlers/ipc-registry');
    const { IPC_CHANNELS } = await import('../../shared/constants');
    const created = await invokeIpcHandler<{ success: boolean; error?: string; data?: Task }>(
      IPC_CHANNELS.TASK_CREATE,
      project.id,
      `Fix: ${task.title}`,
      description,
      { sourceType: 'manual', ...(images?.length ? { attachedImages: images } : {}) }
    );
    if (!created?.success || !created.data) return { success: false, error: created?.error || 'Could not create the follow-up task' };
    const taskId = created.data.id;
    // The newest unplaced card sits at the top of the Queue
    const moved = await invokeIpcHandler<{ success: boolean; error?: string }>(IPC_CHANNELS.TASK_UPDATE_STATUS, taskId, 'queue', undefined, project.id);
    if (!moved?.success) appLog.warn(`[Autonomous] Could not queue the follow-up task ${taskId}:`, moved?.error);
    writeMetadata(project, task, { autoMergeFollowUpTaskId: taskId });
    logTask(project, task, 'info', `changes requested, created follow-up task ${taskId}`);
    notifyChanged(project.id);
    return { success: true, taskId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
