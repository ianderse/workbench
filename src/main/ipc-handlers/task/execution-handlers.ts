import { handleIpc, onIpc } from '../ipc-registry';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, AUTO_BUILD_PATHS, getSpecsDir, resolveGlobalMaxParallelTasks, resolveProjectMaxParallelTasks } from '../../../shared/constants';
import type { IPCResult, TaskStartOptions, TaskStatus, TaskReviewOptions, ImageAttachment, Task, Project, TaskLogs, TaskLogPhase, TaskPhaseLog } from '../../../shared/types';
import path from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { git } from '../../utils/git-exec';
import { AgentManager } from '../../agent';
import { fileWatcher } from '../../file-watcher';
import { findTaskAndProject } from './shared';
import { checkGitStatus } from '../../project-initializer';
import { initializeClaudeProfileManager, type ClaudeProfileManager } from '../../claude-profile-manager';
import { taskStateManager } from '../../task-state-manager';
import {
  getPlanPath,
  persistPlanStatus,
  createPlanIfNotExists,
  hasStartedImplementation,
  resetTaskToInitialState
} from './plan-file-utils';
import { discardTaskWorktree } from '../../utils/worktree-cleanup';
import { dropSplitProposalsForTask } from '../../queue-grooming';
import { appLog } from '../../app-logger';
import { taskLogService } from '../../task-log-service';
import { archiveCurrentRun } from '../../task-run-archive';
import { writeFileAtomicSync } from '../../utils/atomic-file';
import { findTaskWorktree } from '../../worktree-paths';
import { projectStore } from '../../project-store';
import { detectWorktreeBranch } from '../../utils/git-isolation';
import { cancelFallbackTimer } from '../agent-events-handlers';
import { safeSendToRenderer } from '../utils';
import { readSettingsFile } from '../../settings-utils';
import { resolveClaudeCodeTaskSettings } from '../../claude-code/settings';
import { stuckTaskStartupAction } from '../../../shared/utils/task-resume';
import type { ClaudeCodeTaskSettings } from '../../../shared/types/claude-code';
import { getAPIProfileEnv } from '../../services/profile';
import { getAgentBackendSettings } from '../../agent-backend/settings';
import { resolveEffectiveAgent } from '../../../shared/utils/agent-override';
import { loadClaudeRunInfo } from '../../claude-code/task-runner';
import { rateLimitResumeScheduler, type HeldTaskRef } from '../../services/rate-limit-resume-scheduler';
import { clearRateLimitHold } from './rate-limit-hold';
import { taskQueue } from '../../services/task-queue';
import { taskQueueOrder } from '../../services/task-queue-order';
import { countRunningTasks, reachedParallelCap } from '../../../shared/utils/running-tasks';
import { taskHooks } from '../../task-hooks';
import { XSTATE_ACTIVE_STATES } from '../../../shared/state-machines';
import { activeAutoMerge } from '../../../shared/utils/autonomous';
import { createFollowUpTask, getAutonomousTargetSync } from '../../autonomous/autonomous-service';
import { branchMergeBlocker } from '../../worktree/merge-guard';
import { taskResync } from '../../task-resync';
import { clearStoppedByUser, markStoppedByUser } from '../../task-resync/user-stop';
import { deliverToTask, noteTaskMergeBeforeDone } from '../../task-messaging';


/**
 * Feedback typed in "Request changes" with "Start over" ticked, held until the task that was
 * reset actually starts (it may first wait in the queue for a free slot).
 *
 * Held per project and task: a task id is its spec id (`001-<slug>`), which every project numbers
 * from its own start, so two projects can hold the same one. Keyed by the task alone, a second
 * project starting its own `001-x` popped the entry queued for the first project's restart - that
 * project's agent was handed another project's reviewer notes and screenshots as "what the
 * discarded attempt got wrong", and the restart they were written for ran with no feedback at all.
 *
 * Both the writer and the readers have resolved the task's project by the time they touch this
 * map, so the project is part of the key rather than an optional extra: there is no entry here
 * whose project is unknown, and therefore nothing to guess about.
 */
const pendingRestartFeedback = new Map<string, { feedback?: string; feedbackImagePaths?: string[] }>();

/** The key a task's held restart feedback lives under */
const restartFeedbackKey = (projectId: string, taskId: string): string => `${projectId}\u0000${taskId}`;

const AUTH_REQUIRED_MESSAGE = 'Authentication required. Sign in to a Claude account or activate an API profile in Settings > Accounts before starting tasks.';

/** Image types accepted for review feedback (defense in depth - frontend also validates) */
const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];

/**
 * Helper function to ensure profile manager is initialized.
 * Returns a discriminated union for type-safe error handling.
 */
async function ensureProfileManagerInitialized(): Promise<
  | { success: true; profileManager: ClaudeProfileManager }
  | { success: false; error: string }
> {
  try {
    const profileManager = await initializeClaudeProfileManager();
    return { success: true, profileManager };
  } catch (error) {
    console.error('[ensureProfileManagerInitialized] Failed to initialize:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Failed to initialize profile manager. Please check file permissions and disk space. (${errorMessage})`
    };
  }
}

/**
 * Claude Code can run a task: a signed-in Claude profile, or an active API profile
 * (Anthropic-compatible endpoint).
 */
async function checkClaudeCodeAuth(task?: Pick<Task, 'metadata'>): Promise<{ ok: true } | { ok: false; error: string }> {
  // OMP runs local models: no Claude account is needed. The task's own backend decides
  // (a task can pin Claude while the app runs OMP, or the other way round)
  if (resolveEffectiveAgent(task?.metadata?.agentOverride, getAgentBackendSettings().kind).backend === 'omp') return { ok: true };
  const initResult = await ensureProfileManagerInitialized();
  if (!initResult.success) {
    return { ok: false, error: initResult.error };
  }
  if (initResult.profileManager.hasValidAuth()) {
    return { ok: true };
  }
  try {
    if (Object.keys(await getAPIProfileEnv()).length > 0) {
      return { ok: true };
    }
  } catch {
    // Unreadable API profiles: treat as none
  }
  return { ok: false, error: AUTH_REQUIRED_MESSAGE };
}

/** Main spec directory of a task (run state, logs and the plan file live here) */
function getMainSpecDir(project: Project, task: Task): string {
  return path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
}

/** Whether Claude Code already started implementing this task (claude_run.json) */
function hasImplementationRun(project: Project, task: Task): boolean {
  const info = loadClaudeRunInfo(getMainSpecDir(project, task));
  return !!info?.phases.some((phase) => phase.name === 'implement' || phase.name === 'revise');
}

/** Empty phase logs, sent to the renderer when a retry deletes task_logs.json */
function emptyTaskLogs(specId: string): TaskLogs {
  const now = new Date().toISOString();
  const phase = (name: TaskLogPhase): TaskPhaseLog => ({
    phase: name,
    status: 'pending',
    started_at: null,
    completed_at: null,
    entries: []
  });
  return {
    spec_id: specId,
    created_at: now,
    updated_at: now,
    phases: { planning: phase('planning'), coding: phase('coding'), validation: phase('validation') }
  };
}

/**
 * Save review feedback images into `<specDir>/feedback_images/` and return their absolute paths.
 */
function saveFeedbackImages(specDir: string, images: ImageAttachment[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  const imagesDir = path.join(specDir, 'feedback_images');
  const saved: string[] = [];
  try {
    mkdirSync(imagesDir, { recursive: true });
  } catch (dirError) {
    console.error('[TASK_REVIEW] Failed to create images directory:', dirError);
    return [];
  }
  const resolvedImagesDir = path.resolve(imagesDir);
  for (const image of images) {
    try {
      if (!image.data) {
        console.warn('[TASK_REVIEW] Skipping image with no data:', image.filename);
        continue;
      }
      // Reject missing mimeType to prevent bypass attacks
      if (!image.mimeType || !ALLOWED_IMAGE_MIME_TYPES.includes(image.mimeType)) {
        console.warn('[TASK_REVIEW] Skipping image with missing or disallowed MIME type:', image.mimeType);
        continue;
      }
      // Sanitize filename to prevent path traversal attacks
      const sanitizedFilename = path.basename(image.filename);
      if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
        console.warn('[TASK_REVIEW] Skipping image with invalid filename:', image.filename);
        continue;
      }
      // Remove data URL prefix if present (e.g., "data:image/png;base64,")
      const base64Data = image.data.replace(/^data:image\/[^;]+;base64,/, '');
      const imagePath = path.join(imagesDir, sanitizedFilename);
      const resolvedPath = path.resolve(imagePath);
      if (!resolvedPath.startsWith(resolvedImagesDir + path.sep)) {
        console.warn('[TASK_REVIEW] Skipping image with path outside target directory:', image.filename);
        continue;
      }
      writeFileAtomicSync(imagePath, Buffer.from(base64Data, 'base64'));
      saved.push(resolvedPath);
    } catch (imgError) {
      console.error('[TASK_REVIEW] Failed to save image:', image.filename, imgError);
    }
  }
  return saved;
}

/**
 * Start queued tasks whenever a project has free In Progress slots (see services/task-queue.ts).
 * Passes are requested after every status change, and use the same start flow as TASK_START.
 */
/** Total running tasks allowed across all projects (app setting) */
function getGlobalMaxParallelTasks(): number {
  return resolveGlobalMaxParallelTasks((readSettingsFile() as { maxParallelTasks?: number } | undefined)?.maxParallelTasks);
}

function configureTaskQueue(
  agentManager: AgentManager,
  startTask: (taskId: string, projectId?: string) => Promise<void>,
  getMainWindow: () => BrowserWindow | null
): void {
  taskQueue.configure({
    // Cross-project priority: free slots go to a higher-priority project with startable tasks first
    listProjects: () => projectStore.getProjects(),
    onHoldChange: (projectId, hold) =>
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_QUEUE_HOLD, projectId, hold ?? null),
    onUsageChange: (running) => safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_QUEUE_USAGE, running),
    listProjectIds: () => projectStore.getProjects().map((p) => p.id),
    listTasks: (projectId) => projectStore.getTasks(projectId),
    getMaxParallelTasks: () => getGlobalMaxParallelTasks(),
    getProjectMaxParallelTasks: (projectId) =>
      resolveProjectMaxParallelTasks(projectStore.getProject(projectId)?.settings?.maxParallelTasks),
    getQueueOrder: (projectId) => taskQueueOrder.get(projectId),
    isTaskRunning: (taskId, projectId) => agentManager.isRunning(taskId, projectId),
    getAutonomousTarget: (projectId, task) => getAutonomousTargetSync(projectStore.getProject(projectId), task),
    startTask: async (taskId, projectId) => {
      // The queue promotes one project's tasks at a time and says which, so the start never has
      // to guess the project from the task id
      await startTask(taskId, projectId);
      // startTask reports problems (git, auth) to the renderer; it started when the machine is active
      return XSTATE_ACTIVE_STATES.has(taskStateManager.getCurrentState(taskId, projectId) ?? '');
    },
  });
  // Any status change may free a slot (a task leaving In Progress) or queue a task
  taskStateManager.setStatusChangeListener((_taskId, _status, projectId) => taskQueue.request(projectId));
  // When a task stops running anywhere, a slot is free: run the queues of all projects (priority order)
  taskHooks.on('state', () => taskQueue.requestAllProjects());
  handleIpc(IPC_CHANNELS.TASK_QUEUE_HOLDS_GET, () => ({
    holds: taskQueue.getHolds(),
    running: taskQueue.getRunningByProject(),
  }));
}

/**
 * Register task execution handlers (start, stop, review, status management, recovery)
 */
export function registerTaskExecutionHandlers(
  agentManager: AgentManager,
  getMainWindow: () => BrowserWindow | null
): void {
  /** Send a task error to the windows; `projectId` keeps it out of other projects' windows */
  const sendTaskError = (taskId: string, error: string, projectId?: string): void => {
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_ERROR, taskId, error, projectId);
  };

  /** Hand a task to Claude Code and watch its plan file (subtasks, status) */
  const launchRun = (
    taskId: string,
    task: Task,
    project: Project,
    mode: 'start' | 'revise',
    feedback?: string,
    feedbackImagePaths?: string[]
  ): void => {
    // Cancel any pending fallback timer from a previous run's exit, so it can't stop the new run.
    // Named by project, or starting this task would cancel another project's stuck-run net
    cancelFallbackTimer(taskId, project.id);
    // Started again: whatever the user stopped is over (task-resync/user-stop.ts)
    clearStoppedByUser(getMainSpecDir(project, task));

    // The project travels with the watch: two projects can be running a task of the same spec id,
    // each writing its own plan file, and they need a watcher each
    fileWatcher.watch(taskId, getMainSpecDir(project, task), project.id).catch((err) => {
      console.error(`[TASK_START] Failed to watch spec dir for ${taskId}:`, err);
    });

    agentManager.startTask(taskId, { project, task, mode, feedback, feedbackImagePaths }).catch((err) => {
      console.error(`[TASK_START] Failed to start ${taskId}:`, err);
      sendTaskError(taskId, err instanceof Error ? err.message : String(err), project.id);
    });
  };

  /**
   * Start (or continue) a task. Shared by the TASK_START IPC handler and the
   * rate-limit resume scheduler. The Claude Code run continues from its saved
   * state (claude_run.json), so a resumed task doesn't triage or plan again.
   *
   * `projectId` names the task's project, which callers that know it (the queue, the resume
   * scheduler, a retry) pass: a task id is only unique inside a project, so without it the
   * lookup below has to settle for whichever project holds the id first.
   */
  const startTask = async (taskId: string, projectId?: string): Promise<void> => {
    console.warn('[TASK_START] Received request for taskId:', taskId);

    // First search all projects to find the task, then verify the project matches
    // task.projectId to prevent cross-project contamination
    const { task, project: foundProject } = findTaskAndProject(taskId, projectId);
    if (!task || !foundProject) {
      console.warn('[TASK_START] Task or project not found for taskId:', taskId);
      sendTaskError(taskId, 'Task or project not found');
      return;
    }
    const project = (task.projectId && task.projectId !== foundProject.id)
      ? (projectStore.getProject(task.projectId) ?? foundProject)
      : foundProject;

    // Not while the task's branch is being merged: the run would work on a branch that is moving
    const merging = branchMergeBlocker(project.id, taskId);
    if (merging) {
      sendTaskError(taskId, merging, project.id);
      return;
    }

    // Git is required for worktree-based runs
    const gitStatus = await checkGitStatus(project.path);
    if (!gitStatus.isGitRepo) {
      sendTaskError(
        taskId,
        'Git repository required. Please run "git init" in your project directory. Workbench uses git worktrees for isolated builds.',
        project.id
      );
      return;
    }
    if (!gitStatus.hasCommits) {
      sendTaskError(
        taskId,
        'Git repository has no commits. Please make an initial commit first (git add . && git commit -m "Initial commit").',
        project.id
      );
      return;
    }

    const auth = await checkClaudeCodeAuth(task);
    if (!auth.ok) {
      console.warn('[TASK_START] No usable Claude Code authentication');
      sendTaskError(taskId, auth.error, project.id);
      return;
    }

    // Starting (manually or via the resume scheduler) releases any rate-limit hold
    clearRateLimitHold(project, task, getMainWindow);

    // Clear stale tracking state from any previous run so that:
    // - terminalEventSeen doesn't suppress future PROCESS_EXITED events
    // - lastSequenceByTask doesn't drop events from the new run
    taskStateManager.prepareForRestart(taskId, project.id);

    // Move the card to In Progress right away. XState is the source of truth (task data
    // is the fallback after an app restart):
    // - queued (rate-limit hold released) / fresh start: PLANNING_STARTED
    // - human_review / error: USER_RESUMED (coding) when implementation already started,
    //   otherwise PLANNING_STARTED (the run triages/plans first)
    const currentXState = taskStateManager.getCurrentState(taskId, project.id);
    const resumable = currentXState
      ? currentXState === 'human_review' || currentXState === 'error'
      : task.status === 'human_review' || task.status === 'error';
    const event = resumable && hasImplementationRun(project, task) ? 'USER_RESUMED' : 'PLANNING_STARTED';
    console.warn('[TASK_START] XState:', currentXState, '| task status:', task.status, '->', event);
    taskStateManager.handleUiEvent(taskId, { type: event }, task, project);

    // A task reset by "Start over" carries the reviewer's feedback into its fresh run. The
    // feedback is the one left on this project's task: another project's restart of a task with
    // the same spec id has its own entry, which this start must not take
    const feedbackKey = restartFeedbackKey(project.id, taskId);
    const restart = pendingRestartFeedback.get(feedbackKey);
    pendingRestartFeedback.delete(feedbackKey);
    launchRun(taskId, task, project, 'start', restart?.feedback, restart?.feedbackImagePaths);
  };

  /**
   * Start a task. `projectId` is the project of the board the start was pressed on (the Insights
   * task tools send their chat's project): a task id is only unique inside its project, so
   * without it the lookup in `startTask` has to settle for whichever project holds the id and
   * could start another project's task of the same name.
   */
  onIpc(
    IPC_CHANNELS.TASK_START,
    async (_, taskId: string, _options?: TaskStartOptions, projectId?: string) => {
      if (!getMainWindow()) {
        console.warn('[TASK_START] No main window found');
        return;
      }
      await startTask(taskId, projectId);
    }
  );

  /**
   * Whether the app already runs as many tasks as it may in parallel (all projects together, the
   * app setting) or the project its own cap, not counting `taskId`
   */
  const isAtParallelLimit = (project: Project, taskId: string): boolean => {
    const projectRunning = countRunningTasks(projectStore.getTasks(project.id), taskId);
    const otherRunning = projectStore
      .getProjects()
      .filter((p) => p.id !== project.id)
      .reduce((sum, p) => sum + countRunningTasks(projectStore.getTasks(p.id)), 0);
    return (
      reachedParallelCap({
        globalRunning: otherRunning + projectRunning,
        projectRunning,
        globalMax: getGlobalMaxParallelTasks(),
        projectMax: resolveProjectMaxParallelTasks(project.settings?.maxParallelTasks),
      }) !== undefined
    );
  };

  /**
   * Start a task over from a clean slate: discard its worktree and branch (all commits and
   * uncommitted changes), reset its spec dir to what TASK_CREATE wrote (task_metadata.json,
   * attachments/, a fresh implementation_plan.json), forget its state machine, then start
   * it like TASK_START does, or queue it when the parallel task limit is reached.
   *
   * Used by Start over and by "Request changes" with "Start over" ticked; in the latter case the
   * reviewer's feedback and images are kept for the fresh run.
   *
   * Nothing is thrown away without a copy: the worktree's work (commits, uncommitted and untracked
   * files) is first saved on a `workbench/backup/<spec-id>-<time>` branch, reported back as
   * `backupBranch`, and the OMP session transcripts are copied into `previous_runs/`. When the
   * backup fails the task is left as it was.
   *
   * `projectId` is the project the user acted on, sent by the renderer with the request.
   */
  const restartTaskFromScratch = async (
    taskId: string,
    projectId?: string,
    options?: { feedback?: string; images?: ImageAttachment[] }
  ): Promise<IPCResult<{ action: 'started' | 'queued'; backupBranch?: string }>> => {
    const { task, project: foundProject } = findTaskAndProject(taskId, projectId);
    if (!task || !foundProject) {
      return { success: false, error: 'Task not found' };
    }
    const project = (task.projectId && task.projectId !== foundProject.id)
      ? (projectStore.getProject(task.projectId) ?? foundProject)
      : foundProject;

    // Drop whatever an earlier "Start over" left waiting for this project's task, so a Retry with
    // no feedback doesn't hand the fresh run notes about an attempt it knows nothing about. The
    // project has to be resolved first to say whose entry that is, which is why this is not the
    // first thing the restart does
    pendingRestartFeedback.delete(restartFeedbackKey(project.id, taskId));

    // The run is looked up by the project whose worktree and branch this is about to throw away -
    // the one resolved above - so the guard and the reset cannot disagree. Asking with the
    // request's optional id would answer about a project this restart is not touching, and with no
    // id sent and two projects running the task id AgentManager refuses and answers "not running",
    // which would discard a live run's work
    if (agentManager.isRunning(taskId, project.id)) {
      return { success: false, error: 'The task is still running. Stop it before retrying.' };
    }
    const merging = branchMergeBlocker(project.id, taskId);
    if (merging) return { success: false, error: merging };

    // Check that the task can start before throwing its work away
    const gitStatus = await checkGitStatus(project.path);
    if (!gitStatus.isGitRepo || !gitStatus.hasCommits) {
      return { success: false, error: gitStatus.error || 'Git repository with commits required to run tasks.' };
    }
    const auth = await checkClaudeCodeAuth(task);
    if (!auth.ok) {
      return { success: false, error: auth.error };
    }

    try {
      cancelFallbackTimer(taskId, project.id);
      // The watcher closed is the one on the spec dir this restart is about to reset, named by
      // the project resolved above - not whichever project's watcher carries the task id
      await fileWatcher.unwatch(taskId, project.id).catch(() => undefined);
      clearRateLimitHold(project, task, getMainWindow);

      // 1. Revert the code: remove the worktree and its branch. Tasks that run in the
      //    project folder itself (useWorktree: false) keep their changes there.
      let backupBranch: string | undefined;
      if (task.metadata?.useWorktree !== false) {
        const removed = await discardTaskWorktree(project.path, task.specId, '[TASK_RESTART]');
        if (!removed.success) {
          appLog.error(`[TASK_RESTART] ${taskId} not restarted: ${removed.warnings.join('; ')}`);
          return { success: false, error: `Failed to remove the task's worktree: ${removed.warnings.join('; ')}` };
        }
        backupBranch = removed.backupBranch;
        if (backupBranch) appLog.info(`[TASK_RESTART] ${taskId}: saved the discarded work to branch ${backupBranch}`);
      }

      // 2. Keep the run that is being thrown away, so the task dialog can still show what
      //    happened in it, then forget it: the state machine is rebuilt from the reset plan file
      const specDir = getMainSpecDir(project, task);
      archiveCurrentRun(specDir);
      // A split proposed by the run being thrown away no longer applies
      await dropSplitProposalsForTask(project.id, taskId).catch((error) =>
        appLog.warn(`[TASK_RESTART] ${taskId}: could not drop its split proposals:`, error)
      );
      taskStateManager.clearTask(taskId, project.id);
      const queue = isAtParallelLimit(project, taskId);
      await resetTaskToInitialState(project, task, { status: queue ? 'queue' : 'backlog' });

      taskLogService.clearCache(specDir);
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_LOGS_CHANGED, task.specId, emptyTaskLogs(task.specId), project.id);

      // 3. Tell the fresh run what the discarded attempt got wrong. Images are saved after
      //    the reset, which empties the spec dir of everything a run produced
      const feedback = options?.feedback?.trim();
      if (feedback || options?.images?.length) {
        pendingRestartFeedback.set(restartFeedbackKey(project.id, taskId), {
          feedback,
          feedbackImagePaths: saveFeedbackImages(specDir, options?.images)
        });
      }

      // 4. Start over (or wait in the queue for a free slot)
      if (queue) {
        console.warn(`[TASK_RESTART] Parallel task limit reached; ${taskId} reset and queued`);
        safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, 'queue', project.id);
        taskHooks.emit('state', { project, task, status: 'queue' });
        return { success: true, data: { action: 'queued', backupBranch } };
      }
      console.warn(`[TASK_RESTART] ${taskId} reset; starting it again`);
      // The project whose task was just reset, so the fresh run is the one this reset prepared
      await startTask(taskId, project.id);
      return { success: true, data: { action: 'started', backupBranch } };
    } catch (error) {
      console.error('[TASK_RESTART] Failed to retry task:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to retry task' };
    }
  };

  handleIpc(
    IPC_CHANNELS.TASK_RETRY,
    (_, taskId: string, projectId?: string): Promise<IPCResult<{ action: 'started' | 'queued'; backupBranch?: string }>> =>
      restartTaskFromScratch(taskId, projectId)
  );

  /**
   * Resume a task whose rate-limit hold expired (called by the main-process scheduler).
   * Respects the project's parallel task limit: when full, the hold is cleared and
   * the task stays queued so normal queue promotion starts it when a slot frees up.
   */
  const resumeHeldTask = async (taskId: string, projectId: string): Promise<void> => {
    const { task, project } = findTaskAndProject(taskId, projectId);
    if (!task || !project) return;
    if (!task.rateLimitHold || task.status !== 'queue') {
      // Hold already released (user started/moved the task)
      return;
    }
    // The scheduler knows the project of every task it holds, so the run lookup is exact here
    if (agentManager.isRunning(taskId, projectId)) {
      clearRateLimitHold(project, task, getMainWindow);
      return;
    }

    // An automatic start: no free slot, or a higher-priority project that goes first, keeps it
    // queued (the queue starts it later)
    const hold = taskQueue.getHold(projectId);
    if (hold) {
      console.warn(`[RateLimitResume] Hold expired for ${taskId} but the queue is held (${hold.kind}); leaving it queued`);
      clearRateLimitHold(project, task, getMainWindow);
      return;
    }

    console.warn(`[RateLimitResume] Hold expired for ${taskId}, resuming`);
    await startTask(taskId, projectId);
  };

  rateLimitResumeScheduler.configure({
    listHeldTasks: () => {
      const refs: HeldTaskRef[] = [];
      for (const project of projectStore.getProjects()) {
        for (const task of projectStore.getTasks(project.id)) {
          if (task.status === 'queue' && task.rateLimitHold) {
            refs.push({ taskId: task.id, projectId: project.id, resetAt: task.rateLimitHold.resetAt });
          }
        }
      }
      return refs;
    },
    // Serialized with queue promotion so both can't fill the same free slot
    resumeTask: (taskId, projectId) => taskQueue.runExclusive(projectId, () => resumeHeldTask(taskId, projectId)),
  });

  configureTaskQueue(agentManager, startTask, getMainWindow);

  // Tasks on a branch another task was merged into go back to In Progress to take it in
  // (task-resync/): started here, or queued when the project is at its parallel task limit
  taskResync.configure({
    getProject: (projectId) => projectStore.getProject(projectId),
    getTasks: (projectId) => projectStore.getTasks(projectId),
    isRunning: (taskId, projectId) => agentManager.isRunning(taskId, projectId),
    isAtParallelLimit,
    start: (taskId, projectId) => startTask(taskId, projectId),
    queue: async (project, task) => {
      const planPath = getPlanPath(project, task);
      if (!(await persistPlanStatus(planPath, 'queue', project.id))) {
        await createPlanIfNotExists(planPath, task, 'queue');
        projectStore.invalidateTasksCache(project.id);
      }
      safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, task.id, 'queue', project.id);
      taskHooks.emit('state', { project, task, status: 'queue' });
      taskQueue.request(project.id);
    },
    note: async (project, task, text) => {
      await deliverToTask(project.id, task, { kind: 'workbench' }, text);
    },
    runExclusive: (projectId, fn) => taskQueue.runExclusive(projectId, fn),
  });
  // Requests left from before the app was closed, once the projects are loaded
  setTimeout(() => taskResync.scan(projectStore.getProjects().map((p) => p.id)), 10_000).unref?.();

  // The board's Queue column order (top first): the queue starts the top task first
  onIpc(IPC_CHANNELS.TASK_QUEUE_ORDER_SET, (_, projectId: string, order: string[]) => {
    if (typeof projectId !== 'string' || !Array.isArray(order)) return;
    taskQueueOrder.set(projectId, order);
  });

  /**
   * Stop a task
   */
  onIpc(IPC_CHANNELS.TASK_STOP, (_, taskId: string, projectId?: string) => {
    // AgentManager holds its runs per project and task, so the project of the board the user
    // pressed Stop on comes over with the request. When it is missing (an older renderer, or a
    // main-process caller such as the Insights task tools) the bare task id goes through
    // instead: it stops the single run that carries the id and refuses only while two projects
    // run it, which is the one case where no answer exists. Looking the project up from the task
    // id would invent one - the first project holding the id, running the task or not - and
    // stopping that project's absent run is how the button came to do nothing at all.
    const stoppedProjectId = agentManager.killTask(taskId, projectId);
    // The watcher to close belongs to the run that was just stopped: the project the stop came
    // from, or - when it sent none - the project whose run AgentManager found. Closing by task id
    // alone would silence the plan updates of another project's live run
    fileWatcher.unwatch(taskId, projectId ?? stoppedProjectId).catch((err) => {
      console.error('[TASK_STOP] Failed to unwatch:', err);
    });

    // The card to move is the one whose run was just stopped. Without that, a stop sent with no
    // project would kill the right run and then transition whichever project holds the id first
    const { task, project } = findTaskAndProject(taskId, projectId ?? stoppedProjectId);
    if (!task || !project) return;
    // Before the state changes: nothing restarts a task the user stopped (task-resync/user-stop.ts)
    markStoppedByUser(getMainSpecDir(project, task));

    // Stopped before implementation started: back to backlog; otherwise to review
    const hasPlan = hasStartedImplementation(project, task);
    taskStateManager.handleUiEvent(taskId, { type: 'USER_STOPPED', hasPlan }, task, project);

    // Clear stale tracking state so a subsequent restart works correctly
    taskStateManager.prepareForRestart(taskId, project.id);
  });

  /**
   * Review a task: approve (done) or request changes, which Claude Code applies in the
   * task's session before validating again. With `startOver` the worktree is discarded
   * instead and the task is redone from scratch, told what the attempt got wrong.
   */
  handleIpc(
    IPC_CHANNELS.TASK_REVIEW,
    async (
      _,
      taskId: string,
      approved: boolean,
      feedback?: string,
      images?: ImageAttachment[],
      options?: TaskReviewOptions,
      projectId?: string
    ): Promise<IPCResult> => {
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      if (approved) {
        taskStateManager.handleUiEvent(taskId, { type: 'MARK_DONE' }, task, project);
        return { success: true };
      }

      // Merged by autonomous mode: its worktree is behind the target branch, so the change request
      // becomes a new "Fix: ..." task at the top of the Queue that starts from the target branch
      if (activeAutoMerge(task)) {
        const followUp = await createFollowUpTask(project, task, feedback, images as Array<Record<string, unknown>> | undefined);
        return followUp.success ? { success: true } : { success: false, error: followUp.error };
      }

      // Asked of the project whose task the revision will run in - the one resolved above, which
      // is the request's `projectId` whenever it sent one. Asking with that optional id instead
      // would guard a different project from the one `launchRun` below starts, and with no id sent
      // and two projects running the task id AgentManager refuses, so a second run would be
      // launched over this project's live one
      if (agentManager.isRunning(taskId, project.id)) {
        return { success: false, error: 'The task is still running. Stop it before requesting changes.' };
      }
      const merging = branchMergeBlocker(project.id, taskId);
      if (merging) return { success: false, error: merging };

      const auth = await checkClaudeCodeAuth(task);
      if (!auth.ok) {
        return { success: false, error: auth.error };
      }

      // Changes staged in the main project (stage-only merge) are discarded: the work
      // continues in the task's worktree (a fresh one with "Start over")
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath && task.stagedInMainProject) {
        const gitOptions = { cwd: project.path, isolated: true };
        try {
          await git(['reset', 'HEAD'], gitOptions);
          await git(['checkout', '--', '.'], gitOptions);
          // Exclude .workbench to preserve specs and worktree data
          await git(['clean', '-fd', '-e', '.workbench'], gitOptions);
          console.warn('[TASK_REVIEW] Main project restored to pre-merge state');
        } catch (error) {
          console.warn('[TASK_REVIEW] Could not discard staged changes in the main project:', error);
        }
      }

      // "Start over": throw the attempt away (worktree, branch and run history) and redo the
      // task from scratch, with the feedback as the reviewer's notes on the discarded attempt
      if (options?.startOver) {
        // The project this review is about, so the restart resolves the same task this handler did
        const restarted = await restartTaskFromScratch(taskId, project.id, { feedback, images });
        return restarted.success ? { success: true } : { success: false, error: restarted.error };
      }

      const feedbackImagePaths = saveFeedbackImages(getMainSpecDir(project, task), images);

      // Clear stale tracking state before starting the revision
      taskStateManager.prepareForRestart(taskId, project.id);
      taskStateManager.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);

      // The feedback goes over as the reviewer left it, empty included: a reviewer who asked for
      // the changes in screenshots alone said plenty, and standing a "No feedback provided"
      // placeholder in for the text they didn't type told the run the opposite. The run composes
      // what to say from the text and the images together (`reviewerFeedback` in task-runner.ts)
      launchRun(taskId, task, project, 'revise', feedback?.trim(), feedbackImagePaths);
      return { success: true };
    }
  );

  /**
   * Update task status manually
   * Options:
   * - forceCleanup: When setting to 'done' with a worktree present, delete the worktree first
   */
  handleIpc(
    IPC_CHANNELS.TASK_UPDATE_STATUS,
    async (
      _,
      taskId: string,
      status: TaskStatus,
      options?: { forceCleanup?: boolean; keepWorktree?: boolean },
      projectId?: string
    ): Promise<IPCResult & { worktreeExists?: boolean; worktreePath?: string }> => {
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      // 'done' can only be set through the merge handler UNLESS there's no worktree
      // (already merged/discarded or failed), forceCleanup is requested (user confirmed
      // deleting the worktree) or keepWorktree is requested
      if (status === 'done') {
        const worktreePath = findTaskWorktree(project.path, task.specId);
        // A merge made outside Workbench is found from the task's branch, which the cleanup
        // below deletes: look now (task-messaging/notices.ts)
        if (task.status !== 'done' && (!worktreePath || options?.keepWorktree || options?.forceCleanup)) {
          await noteTaskMergeBeforeDone(project, task);
        }
        if (worktreePath) {
          if (options?.keepWorktree) {
            console.warn(`[TASK_UPDATE_STATUS] Marking task ${taskId} as done while keeping worktree at ${worktreePath}`);
          } else if (options?.forceCleanup || activeAutoMerge(task) || task.metadata?.specReview) {
            // (a task merged by autonomous mode is in its target branch already: Done only cleans up;
            // a Spec review ticket changes no code, so its worktree holds nothing to keep)
            console.warn(`[TASK_UPDATE_STATUS] Cleaning up worktree for task ${taskId} (user confirmed)`);
            try {
              // Validate the detected branch matches the expected pattern, so a corrupted
              // or orphaned worktree can't make us delete the wrong branch
              const { branch, usingFallback: usingFallbackBranch } = await detectWorktreeBranch(
                worktreePath,
                task.specId,
                { timeout: 30000, logPrefix: '[TASK_UPDATE_STATUS]' }
              );
              await git(['worktree', 'remove', '--force', worktreePath], {
                cwd: project.path,
                timeout: 30000,
                isolated: true
              });
              console.warn(`[TASK_UPDATE_STATUS] Worktree removed: ${worktreePath}`);
              try {
                await git(['branch', '-D', branch], {
                  cwd: project.path,
                  timeout: 30000,
                  isolated: true
                });
                console.warn(`[TASK_UPDATE_STATUS] Branch deleted: ${branch}`);
              } catch (branchDeleteError) {
                console.warn(
                  usingFallbackBranch
                    ? `[TASK_UPDATE_STATUS] Could not delete branch ${branch} using fallback pattern. Actual branch may still exist and need manual cleanup.`
                    : `[TASK_UPDATE_STATUS] Could not delete branch ${branch} (may not exist or be checked out elsewhere)`,
                  branchDeleteError
                );
              }
            } catch (cleanupError) {
              console.error(`[TASK_UPDATE_STATUS] Failed to cleanup worktree:`, cleanupError);
              return {
                success: false,
                error: `Failed to cleanup worktree: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
              };
            }
          } else {
            // Worktree exists but no forceCleanup - ask the user to confirm
            return {
              success: false,
              worktreeExists: true,
              worktreePath: worktreePath,
              error: "A worktree still exists for this task. Would you like to delete it and mark the task as complete?"
            };
          }
        }
      }

      const planPath = getPlanPath(project, task);

      try {
        // Manually moving a held task out of the queue releases its rate-limit hold
        if (status !== 'queue') {
          clearRateLimitHold(project, task, getMainWindow);
        }

        // Stop the run when the task is moved away from In Progress (e.g., back to backlog)
        // BEFORE the machine transition, so the run's late events can't move it back.
        // Every run lookup here names the project this handler acts on - the one resolved from the
        // task id, which is the request's `projectId` whenever it sent one. The request's optional
        // id is not a substitute: with none sent and another project running a task of this spec
        // id, AgentManager would answer about that project, so moving the card would stop or start
        // nothing while this project's run carried on, or start a second run over it
        if (status !== 'in_progress' && agentManager.isRunning(taskId, project.id)) {
          console.warn('[TASK_UPDATE_STATUS] Stopping task due to status change away from in_progress:', taskId);
          markStoppedByUser(getMainSpecDir(project, task));
          agentManager.killTask(taskId, project.id);
          fileWatcher.unwatch(taskId, project.id).catch(() => undefined);
        }

        if (status === 'in_progress' && !agentManager.isRunning(taskId, project.id)) {
          const merging = branchMergeBlocker(project.id, taskId);
          if (merging) {
            sendTaskError(taskId, merging, project.id);
            return { success: false, error: merging };
          }
          // Check git status and auth before the card moves
          const gitStatusCheck = await checkGitStatus(project.path);
          if (!gitStatusCheck.isGitRepo || !gitStatusCheck.hasCommits) {
            const error = gitStatusCheck.error || 'Git repository with commits required to run tasks.';
            sendTaskError(taskId, error, project.id);
            return { success: false, error };
          }
          const auth = await checkClaudeCodeAuth(task);
          if (!auth.ok) {
            sendTaskError(taskId, auth.error, project.id);
            return { success: false, error: auth.error };
          }
          taskStateManager.prepareForRestart(taskId, project.id);
        }

        const handledByMachine = taskStateManager.handleManualStatusChange(taskId, status, task, project);
        if (!handledByMachine) {
          // Thread-safe plan file update (legacy/manual override)
          const persisted = await persistPlanStatus(planPath, status, project.id);
          if (!persisted) {
            await createPlanIfNotExists(planPath, task, status);
            projectStore.invalidateTasksCache(project.id);
          }
          taskHooks.emit('state', { project, task, status });
        }

        // Auto-start the task when it is moved to In Progress and isn't running
        if (status === 'in_progress' && !agentManager.isRunning(taskId, project.id)) {
          console.warn('[TASK_UPDATE_STATUS] Auto-starting task:', taskId);
          launchRun(taskId, task, project, 'start');
          safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, 'in_progress', project.id);
        }

        // A task moved to the queue (or out of In Progress) may be startable right away
        taskQueue.request(project.id);

        return { success: true };
      } catch (error) {
        console.error('Failed to update task status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update task status'
        };
      }
    }
  );

  /**
   * Check if a task is actually running (has an active run)
   */
  handleIpc(
    IPC_CHANNELS.TASK_CHECK_RUNNING,
    async (_, taskId: string, projectId?: string): Promise<IPCResult<boolean>> => {
      // The project of the card that is asking: runs are held per project and task, and a task
      // id alone belongs to as many tasks as there are projects holding it. Searching the
      // projects for the id would answer about whichever one came first - "not running" for a
      // task that is running, which is what makes a card offer to recover a live run.
      return { success: true, data: agentManager.isRunning(taskId, projectId) };
    }
  );

  /**
   * Recover a stuck task (status says in_progress but nothing is running).
   * Moves it to review when Claude Code finished implementing, otherwise back to the
   * backlog (or the requested status), and optionally restarts it.
   */
  const recoverStuckTask = async (
      taskId: string,
      options?: { targetStatus?: TaskStatus; autoRestart?: boolean },
      projectId?: string
    ): Promise<IPCResult<{ taskId: string; recovered: boolean; newStatus: TaskStatus; message: string; autoRestarted?: boolean }>> => {
      const autoRestart = options?.autoRestart ?? false;

      // The task is resolved before the run is looked up, because recovery rewrites that task's
      // plan files and forgets its state machine: the project it is about to write to is the
      // project whose run has to be idle. Asking AgentManager with the request's optional id
      // instead would check a project this recovery is not touching, and with no id sent and two
      // projects running a task of this spec id it refuses and answers "not running", letting
      // recovery rewrite the plan file under this project's live run
      const { task, project } = findTaskAndProject(taskId, projectId);
      if (!task || !project) {
        return { success: false, error: 'Task not found' };
      }

      if (agentManager.isRunning(taskId, project.id)) {
        return {
          success: false,
          error: 'Task is still running. Stop it first before recovering.',
          data: { taskId, recovered: false, newStatus: 'in_progress', message: 'Task is still running' }
        };
      }

      // Where the run got to decides the recovery status
      const runInfo = loadClaudeRunInfo(getMainSpecDir(project, task));
      const implemented = !!runInfo?.phases.some(
        (p) => (p.name === 'implement' || p.name === 'revise') && p.endedAt && !p.isError
      );
      let newStatus: TaskStatus = options?.targetStatus ?? (implemented ? 'human_review' : 'backlog');

      // Plan files to update: main spec dir and the worktree copy
      const specsBaseDir = getSpecsDir(project.autoBuildPath);
      const planPaths = [getPlanPath(project, task)];
      const worktreePath = findTaskWorktree(project.path, task.specId);
      if (worktreePath) {
        const worktreePlanPath = path.join(worktreePath, specsBaseDir, task.specId, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN);
        if (existsSync(worktreePlanPath)) planPaths.push(worktreePlanPath);
      }

      const writeRecoveredStatus = (status: TaskStatus): boolean => {
        let wrote = false;
        for (const planPath of planPaths) {
          try {
            let plan: Record<string, unknown> = {};
            try {
              plan = JSON.parse(readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
            } catch (readError) {
              if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
            }
            plan.status = status;
            plan.planStatus = status === 'done' ? 'completed'
              : status === 'in_progress' ? 'in_progress'
              : status === 'ai_review' || status === 'human_review' ? 'review'
              : 'pending';
            // Keep executionPhase/xstateState in sync: project-store restores from them
            plan.xstateState = status === 'in_progress' ? 'coding' : status;
            plan.executionPhase = status === 'human_review' || status === 'done' ? 'complete'
              : status === 'in_progress' ? 'coding'
              : 'idle';
            if (status === 'human_review') plan.reviewReason = implemented ? 'completed' : 'stopped';
            plan.recoveryNote = `Task recovered from stuck state at ${new Date().toISOString()}`;
            plan.updated_at = new Date().toISOString();
            writeFileAtomicSync(planPath, JSON.stringify(plan, null, 2));
            wrote = true;
          } catch (writeError) {
            console.error(`[Recovery] Failed to write plan file at ${planPath}:`, writeError);
          }
        }
        projectStore.invalidateTasksCache(project.id);
        return wrote;
      };

      try {
        if (!writeRecoveredStatus(newStatus)) {
          return { success: false, error: 'Failed to write plan file during recovery' };
        }
        // The XState actor still thinks the task is active: rebuild it from the files
        taskStateManager.clearTask(taskId, project.id);

        fileWatcher.unwatch(taskId, project.id).catch((err) => {
          console.error('[TASK_RECOVER_STUCK] Failed to unwatch:', err);
        });

        let autoRestarted = false;
        let restartProblem: string | undefined;
        if (autoRestart) {
          const gitStatusForRestart = await checkGitStatus(project.path);
          const auth = gitStatusForRestart.isGitRepo && gitStatusForRestart.hasCommits
            ? await checkClaudeCodeAuth(task)
            : { ok: false as const, error: gitStatusForRestart.error || 'Git repository with commits required.' };
          if (!auth.ok) {
            restartProblem = auth.error;
          } else {
            const { task: freshTask } = findTaskAndProject(taskId, project.id);
            const restartTask = freshTask ?? task;
            taskStateManager.handleUiEvent(
              taskId,
              { type: implemented ? 'USER_RESUMED' : 'PLANNING_STARTED' },
              restartTask,
              project
            );
            launchRun(taskId, restartTask, project, 'start');
            newStatus = 'in_progress';
            autoRestarted = true;
          }
        }

        safeSendToRenderer(getMainWindow, IPC_CHANNELS.TASK_STATUS_CHANGE, taskId, newStatus, project.id);

        return {
          success: true,
          data: {
            taskId,
            recovered: true,
            newStatus,
            message: autoRestarted
              ? 'Task recovered and restarted successfully'
              : restartProblem
                ? `Task recovered but cannot restart: ${restartProblem}`
                : `Task recovered successfully and moved to ${newStatus}`,
            autoRestarted
          }
        };
      } catch (error) {
        console.error('Failed to recover stuck task:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to recover task'
        };
      }
    };

  handleIpc(
    IPC_CHANNELS.TASK_RECOVER_STUCK,
    (_, taskId: string, options?: { targetStatus?: TaskStatus; autoRestart?: boolean }, projectId?: string) =>
      recoverStuckTask(taskId, options, projectId)
  );

  // Tasks the app left running when it quit (a crash, a restart, the Mac going down) are stuck:
  // their runs are gone. Once the app has settled, continue each unfinished run in its own
  // worktree and session, and move a finished one on to review, so an unattended queue keeps going
  setTimeout(() => {
    void resumeStuckTasksOnStart(recoverStuckTask, (taskId, projectId) => agentManager.isRunning(taskId, projectId));
  }, STUCK_RESUME_DELAY_MS).unref?.();
}

/** After startup, before the autonomous check merges finished tasks (10 s) */
const STUCK_RESUME_DELAY_MS = 8_000;

async function resumeStuckTasksOnStart(
  recover: (taskId: string, options: { autoRestart: boolean }, projectId: string) => Promise<IPCResult<unknown>>,
  isRunning: (taskId: string, projectId: string) => boolean
): Promise<void> {
  const validation = resolveClaudeCodeTaskSettings((readSettingsFile() as { claudeCodeTasks?: Partial<ClaudeCodeTaskSettings> } | undefined)?.claudeCodeTasks).validation;
  for (const project of projectStore.getProjects()) {
    for (const task of projectStore.getTasks(project.id)) {
      if (task.status !== 'in_progress' && task.status !== 'ai_review') continue;
      const action = stuckTaskStartupAction(task, loadClaudeRunInfo(getMainSpecDir(project, task)), isRunning(task.id, project.id), validation);
      if (!action) continue;
      const finished = action === 'review';
      appLog.info(`[TASK_RESUME_ON_START] ${task.specId}: left ${task.status} by the last session, ${finished ? 'moving its finished run to review' : 'resuming it'}`);
      const result = await recover(task.id, { autoRestart: !finished }, project.id);
      if (!result.success) {
        appLog.warn(`[TASK_RESUME_ON_START] ${task.specId}: could not recover: ${result.error ?? 'unknown error'}`);
        taskHooks.emit('needs-attention', { project, task, reason: 'resume-failed' });
      }
    }
  }
}

// Re-exported for callers that reset a task's run (e.g. discarding its worktree)
;
