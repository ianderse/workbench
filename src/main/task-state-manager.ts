import { createActor } from 'xstate';
import type { ActorRefFrom } from 'xstate';
import type { BrowserWindow } from 'electron';
import type { TaskEventPayload } from './agent/task-event-schema';
import type { Project, Task, TaskStatus, ReviewReason, ExecutionPhase } from '../shared/types';
import { taskMachine, XSTATE_TO_PHASE, mapStateToLegacy, type TaskEvent } from '../shared/state-machines';
import { IPC_CHANNELS } from '../shared/constants';
import { safeSendToRenderer } from './ipc-handlers/utils';
import { getPlanPath, persistPlanStatusAndReasonSync } from './ipc-handlers/task/plan-file-utils';
import { findTaskWorktree } from './worktree-paths';
import { taskHooks } from './task-hooks';
import { getSpecsDir, AUTO_BUILD_PATHS } from '../shared/constants';
import { existsSync } from 'fs';
import path from 'path';
import { appLog } from './app-logger';

type TaskActor = ActorRefFrom<typeof taskMachine>;

interface TaskContextEntry {
  task: Task;
  project: Project;
}

/**
 * A task id is its spec id (`001-<slug>`), which each project numbers from its own start, so two
 * projects can hold the same one. Everything below is therefore held per project and task: keyed
 * by the task alone, one project's run reads the other's state machine, has its events dropped
 * for being behind the other's sequence numbers, and takes the other's terminal event as its own.
 * The shape is `AgentState`'s, separator included; an entry stored before its project was known
 * keeps the empty project until a caller names one.
 */
const stateKey = (taskId: string, projectId?: string): string => `${projectId ?? ''}\u0000${taskId}`;

/**
 * The project and the task a key was built from. Neither id can contain the separator, so the
 * project is everything before the first one and the task everything after it - which is what a
 * lookup by bare task id has to compare against, having no project to build a key from.
 */
const keyProjectId = (key: string): string => key.slice(0, key.indexOf('\u0000'));
const keyTaskId = (key: string): string => key.slice(key.indexOf('\u0000') + 1);

interface ActorEntry {
  actor: TaskActor;
  taskId: string;
  /**
   * The project the actor's state is keyed under, empty only while no caller has named one. Its
   * subscriber reads this on every transition instead of closing over the key, so an actor
   * adopted by its project (`keyForProject`) goes on emitting under the key its state moved to.
   */
  projectId?: string;
}

/** Carry a map entry over to another key, for an actor adopted by its project */
function moveEntry<V>(map: Map<string, V>, from: string, to: string): void {
  if (!map.has(from)) return;
  map.set(to, map.get(from) as V);
  map.delete(from);
}

const TERMINAL_EVENTS = new Set<string>([
  'QA_PASSED',
  'QA_FAILED',
  'PLANNING_FAILED',
  'CODING_FAILED',
  'QA_MAX_ITERATIONS',
  'QA_AGENT_ERROR',
  'ALL_SUBTASKS_DONE',
  'RATE_LIMIT_HOLD'
]);

export class TaskStateManager {
  // Every one of these is keyed by project and task (`stateKey`), never by the task alone
  private actors = new Map<string, ActorEntry>();
  private lastSequenceByTask = new Map<string, number>();
  private lastStateByTask = new Map<string, string>();
  private taskContextById = new Map<string, TaskContextEntry>();
  private terminalEventSeen = new Set<string>();
  private getMainWindow: (() => BrowserWindow | null) | null = null;
  private onTaskCompleted: ((taskId: string, project: Project) => void) | null = null;
  private onStatusChange: ((taskId: string, status: TaskStatus, projectId: string) => void) | null = null;

  configure(getMainWindow: () => BrowserWindow | null): void {
    this.getMainWindow = getMainWindow;
  }

  /**
   * Called when a task completes: its build finished and passed QA (human review, "completed"),
   * or it was marked done (merged)
   */
  setTaskCompletedListener(listener: (taskId: string, project: Project) => void): void {
    this.onTaskCompleted = listener;
  }

  /**
   * Called after every status the machine emits (persisted first), e.g. so the task
   * queue can fill a slot freed by a task leaving In Progress. The project is always known
   * - the machine emits for a task it was given with its project - and the queue needs it to
   * know which project has the free slot, so it is handed over rather than left optional.
   */
  setStatusChangeListener(listener: ((taskId: string, status: TaskStatus, projectId: string) => void) | null): void {
    this.onStatusChange = listener;
  }

  handleTaskEvent(taskId: string, event: TaskEventPayload, task: Task, project: Project): boolean {
    const key = this.keyForProject(taskId, project.id);
    const lastSeq = this.lastSequenceByTask.get(key);
    console.debug(`[TaskStateManager] handleTaskEvent: ${event.type} seq=${event.sequence}, lastSeq=${lastSeq}`);

    if (!this.isNewSequence(key, event.sequence)) {
      console.debug(`[TaskStateManager] Event ${event.type} DROPPED - sequence ${event.sequence} not newer than ${lastSeq}`);
      return false;
    }
    this.setTaskContext(key, task, project);
    this.lastSequenceByTask.set(key, event.sequence);

    if (TERMINAL_EVENTS.has(event.type)) {
      this.terminalEventSeen.add(key);
    }

    const actor = this.getOrCreateActor(key, taskId, project.id);
    const stateBefore = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] Sending ${event.type} to actor in state: ${stateBefore}`);
    actor.send(event as TaskEvent);
    const stateAfter = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] After ${event.type}: state ${stateBefore} -> ${stateAfter}`);
    return true;
  }

  /**
   * `projectId` is for the one caller that knows the project an exit came from without having
   * found its task: the run's own exit event carries it, while the task lookup it feeds can still
   * come back empty (a task deleted while it ran, a project removed from the board).
   */
  handleProcessExited(
    taskId: string,
    exitCode: number | null,
    task?: Task,
    project?: Project,
    projectId?: string
  ): void {
    const owner = project?.id ?? projectId;
    const key = this.writeKey(taskId, owner, 'handleProcessExited');
    if (key === undefined) {
      return;
    }
    if (task && project) {
      this.setTaskContext(key, task, project);
    }
    if (this.terminalEventSeen.has(key)) {
      return;
    }
    const actor = this.getOrCreateActor(key, taskId, owner);
    // Only mark as unexpected if the run ended with a non-zero code
    const isUnexpected = exitCode !== 0;
    actor.send({
      type: 'PROCESS_EXITED',
      exitCode: exitCode ?? -1,
      unexpected: isUnexpected
    } satisfies TaskEvent);
  }

  handleUiEvent(taskId: string, event: TaskEvent, task: Task, project: Project): void {
    console.debug(`[TaskStateManager] handleUiEvent: ${event.type} for task ${taskId}`);
    const key = this.keyForProject(taskId, project.id);
    this.setTaskContext(key, task, project);
    const actor = this.getOrCreateActor(key, taskId, project.id);
    const stateBefore = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] Sending UI event ${event.type} to actor in state: ${stateBefore}`);
    actor.send(event);
    const stateAfter = String(actor.getSnapshot().value);
    console.debug(`[TaskStateManager] After UI event ${event.type}: state ${stateBefore} -> ${stateAfter}`);
  }

  handleManualStatusChange(taskId: string, status: TaskStatus, task: Task, project: Project): boolean {
    switch (status) {
      case 'done':
        this.handleUiEvent(taskId, { type: 'MARK_DONE' }, task, project);
        return true;
      case 'pr_created':
        this.handleUiEvent(
          taskId,
          { type: 'PR_CREATED', prUrl: task.metadata?.prUrl ?? '' },
          task,
          project
        );
        return true;
      case 'in_progress': {
        // Use XState as source of truth for determining correct event
        const currentState = this.getCurrentState(taskId, project.id);
        if (currentState === 'queued' || (!currentState && task.status === 'queue' && task.rateLimitHold)) {
          // Rate-limit hold released: restart via planning; the Claude Code run continues
          // from its saved state (triage/plan/implementation aren't repeated)
          this.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
        } else if (currentState === 'human_review' || currentState === 'error') {
          this.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
        } else if (
          currentState === 'backlog' ||
          (!currentState && (task.status === 'backlog' || (task.status === 'queue' && !task.rateLimitHold)))
        ) {
          // Fresh start (drag to In Progress / queue promotion): backlog ignores USER_RESUMED
          this.handleUiEvent(taskId, { type: 'PLANNING_STARTED' }, task, project);
        } else {
          this.handleUiEvent(taskId, { type: 'USER_RESUMED' }, task, project);
        }
        return true;
      }
      case 'backlog':
        // Back to Planning from any column it may be moved from (Queue, AI Review, Human Review)
        this.handleUiEvent(taskId, { type: 'MOVED_TO_BACKLOG' }, task, project);
        return true;
      case 'human_review':
        // Already in human_review (e.g., stage-only merge keeps task in review).
        // Emit status directly since there's no XState transition needed.
        this.emitStatus(taskId, 'human_review', task.reviewReason ?? 'completed', project.id);
        taskHooks.emit('state', { project, task, status: 'human_review', state: 'human_review' });
        return true;
      default:
        return false;
    }
  }

  setLastSequence(taskId: string, sequence: number, projectId?: string): void {
    const key = this.writeKey(taskId, projectId, 'setLastSequence');
    if (key !== undefined) {
      this.lastSequenceByTask.set(key, sequence);
    }
  }

  getLastSequence(taskId: string, projectId?: string): number | undefined {
    const key = this.resolveKey(taskId, projectId, 'getLastSequence');
    return key !== undefined ? this.lastSequenceByTask.get(key) : undefined;
  }

  /**
   * Get the current XState state for a task of a project.
   * Returns undefined if no actor exists for it.
   */
  getCurrentState(taskId: string, projectId?: string): string | undefined {
    const key = this.resolveKey(taskId, projectId, 'getCurrentState');
    const entry = key !== undefined ? this.actors.get(key) : undefined;
    if (!entry) {
      return undefined;
    }
    return String(entry.actor.getSnapshot().value);
  }

  /**
   * Reset tracking state for a task that is about to be restarted.
   * Clears terminalEventSeen (so process exits aren't swallowed) and
   * lastSequenceByTask (so events from the new process aren't dropped
   * as duplicates). Does NOT stop or remove the XState actor, since
   * the caller may still need to send events to it.
   */
  prepareForRestart(taskId: string, projectId?: string): void {
    const key = this.resolveKey(taskId, projectId, 'prepareForRestart');
    if (key === undefined) {
      return;
    }
    this.terminalEventSeen.delete(key);
    this.lastSequenceByTask.delete(key);
  }

  clearTask(taskId: string, projectId?: string): void {
    const key = this.resolveKey(taskId, projectId, 'clearTask');
    if (key !== undefined) {
      this.dropKey(key);
    }
  }

  /**
   * Clear task state. Called by the TASK_LIST handler when forceRefresh is true, with the project
   * whose board asked: actors are then recreated from that project's fresh task data, while the
   * other projects' running tasks keep the machines their events are driving. State held under no
   * project yet is left for whichever project claims it, since it may be another project's.
   *
   * Note: lastSequenceByTask is preserved to prevent duplicate event processing
   * if backend events arrive during the refresh window. Sequence numbers are
   * specific to task execution sessions and should remain valid across UI refreshes.
   */
  clearAllTasks(projectId?: string): void {
    for (const key of this.heldKeys()) {
      if (projectId !== undefined && keyProjectId(key) !== projectId) {
        continue;
      }
      this.actors.get(key)?.actor.stop();
      this.actors.delete(key);
      // Preserve lastSequenceByTask to prevent duplicate event processing during refresh
      // Only clear state that needs to be rebuilt from fresh task data
      this.lastStateByTask.delete(key);
      this.terminalEventSeen.delete(key);
      this.taskContextById.delete(key);
    }
    appLog.info(
      `[TaskStateManager] Cleared task actors and state for refresh of ${projectId ?? 'every project'} (preserved sequence tracking)`
    );
  }

  /** Every key any of the collections holds, which is what a project-wide or global sweep walks */
  private heldKeys(): Set<string> {
    const keys = new Set<string>();
    for (const collection of this.collections()) {
      for (const key of collection.keys()) keys.add(key);
    }
    return keys;
  }

  /** The collections a task's state lives in, so one lookup can answer for all of them */
  private collections(): Array<{ has(key: string): boolean; keys(): IterableIterator<string> }> {
    return [
      this.actors,
      this.lastSequenceByTask,
      this.lastStateByTask,
      this.taskContextById,
      this.terminalEventSeen
    ];
  }

  private heldAt(key: string): boolean {
    return this.collections().some((collection) => collection.has(key));
  }

  /**
   * The key a task's state is held under, or undefined when none of it is held for the task.
   *
   * A caller that names the project gets that project's state, and otherwise state stored before
   * any project was known - never another project's. Almost every caller names one now (the board
   * sends the project of the card the user acted on, and the handlers pass it through), but a bare
   * task id still has to answer for the callers that genuinely have none, such as a file-watcher
   * event: with one project holding the task there is nothing to confuse it with. When two
   * projects hold it there is no honest answer, and guessing would report the other project's run
   * as active or stop its actor, so the lookup says which task it was asked about and refuses.
   */
  private resolveKey(taskId: string, projectId: string | undefined, operation: string): string | undefined {
    const { key, ambiguous } = this.locate(taskId, projectId);
    if (ambiguous) {
      appLog.warn(
        `[TaskStateManager] ${operation}: ${taskId} is in more than one project and no project was named, doing nothing`
      );
    }
    return key;
  }

  /**
   * The lookup itself: `ambiguous` tells a caller that has to write apart from one that only
   * reads, since storing state under no project while two projects hold the task would leave a
   * third entry that every later bare-task-id lookup would find first.
   */
  private locate(
    taskId: string,
    projectId: string | undefined
  ): { key: string | undefined; ambiguous: boolean } {
    const exact = stateKey(taskId, projectId);
    if (this.heldAt(exact)) return { key: exact, ambiguous: false };
    if (projectId) {
      const projectless = stateKey(taskId, undefined);
      return { key: this.heldAt(projectless) ? projectless : undefined, ambiguous: false };
    }

    let found: string | undefined;
    for (const key of this.heldKeys()) {
      if (keyTaskId(key) !== taskId) continue;
      if (found !== undefined) return { key: undefined, ambiguous: true };
      found = key;
    }
    return { key: found, ambiguous: false };
  }

  /**
   * The key a caller that names its project writes under. State stored before any project was
   * known - a process exit whose task lookup came back empty - is carried over to it instead of
   * being left behind: a second entry for the same task would make every later bare-id lookup
   * ambiguous, and a second actor for one task run would emit that task's statuses twice. The
   * actor moves with its state, so an in-flight machine keeps its current state and its
   * subscription; only the key it is filed under changes.
   */
  private keyForProject(taskId: string, projectId: string): string {
    const key = stateKey(taskId, projectId);
    const projectless = stateKey(taskId, undefined);
    if (!this.heldAt(projectless)) return key;
    if (this.heldAt(key)) {
      // The project's own state took over in the meantime, so what is left under no project is
      // stale and would answer a later bare lookup in place of it
      this.dropKey(projectless);
      return key;
    }
    const entry = this.actors.get(projectless);
    if (entry) {
      entry.projectId = projectId;
      this.actors.set(key, entry);
      this.actors.delete(projectless);
    }
    moveEntry(this.lastSequenceByTask, projectless, key);
    moveEntry(this.lastStateByTask, projectless, key);
    moveEntry(this.taskContextById, projectless, key);
    if (this.terminalEventSeen.delete(projectless)) this.terminalEventSeen.add(key);
    return key;
  }

  /**
   * The key a write belongs under: the project's own when one is named, otherwise whatever entry
   * the task id already has, or a fresh projectless one. Refuses when two projects hold the task
   * and none was named, rather than adding a third entry that outranks both.
   */
  private writeKey(taskId: string, projectId: string | undefined, operation: string): string | undefined {
    if (projectId !== undefined) return this.keyForProject(taskId, projectId);
    const { key, ambiguous } = this.locate(taskId, undefined);
    if (ambiguous) {
      appLog.warn(
        `[TaskStateManager] ${operation}: ${taskId} is in more than one project and no project was named, doing nothing`
      );
      return undefined;
    }
    return key ?? stateKey(taskId, undefined);
  }

  /** Forget everything held under one key, stopping its actor */
  private dropKey(key: string): void {
    this.lastSequenceByTask.delete(key);
    this.lastStateByTask.delete(key);
    this.terminalEventSeen.delete(key);
    this.taskContextById.delete(key);
    const entry = this.actors.get(key);
    if (entry) {
      entry.actor.stop();
      this.actors.delete(key);
    }
  }

  private setTaskContext(key: string, task: Task, project: Project): void {
    this.taskContextById.set(key, { task, project });
  }

  private getOrCreateActor(key: string, taskId: string, projectId?: string): TaskActor {
    const existing = this.actors.get(key);
    if (existing) {
      console.debug(`[TaskStateManager] Using existing actor for ${taskId}, current state:`, String(existing.actor.getSnapshot().value));
      return existing.actor;
    }

    const contextEntry = this.taskContextById.get(key);
    const snapshot = contextEntry
      ? this.buildSnapshotFromTask(contextEntry.task)
      : undefined;

    if (contextEntry) {
      console.debug(`[TaskStateManager] Creating new actor for ${taskId} from task:`, {
        status: contextEntry.task.status,
        reviewReason: contextEntry.task.reviewReason,
        phase: contextEntry.task.executionProgress?.phase,
        initialState: snapshot ? String(snapshot.value) : 'default (backlog)'
      });
    } else {
      console.debug(`[TaskStateManager] Creating new actor for ${taskId} with default state (no context entry)`);
    }

    const actor = snapshot
      ? createActor(taskMachine, { snapshot })
      : createActor(taskMachine);
    const actorEntry: ActorEntry = { actor, taskId, projectId };
    actor.subscribe((snapshot) => {
      // The key is read from the entry on every transition rather than closed over: an actor
      // adopted by its project is re-keyed under it, and a captured key would go on writing the
      // task's last state and reading its context under the key the actor was created with
      const key = stateKey(actorEntry.taskId, actorEntry.projectId);
      const stateValue = String(snapshot.value);
      const lastState = this.lastStateByTask.get(key);

      console.debug(`[TaskStateManager] XState transition for ${taskId}:`, {
        from: lastState,
        to: stateValue,
        contextReviewReason: snapshot.context.reviewReason
      });

      if (lastState === stateValue) {
        return;
      }
      this.lastStateByTask.set(key, stateValue);

      const contextEntry = this.taskContextById.get(key);
      if (!contextEntry) {
        console.debug(`[TaskStateManager] No context for task ${taskId} during state transition to ${stateValue} - skipping emit (may occur after clearTask during event processing)`);
        return;
      }
      const { task, project } = contextEntry;
      const { status, reviewReason } = mapStateToLegacy(
        stateValue,
        snapshot.context.reviewReason
      );

      // Map XState state to execution phase for persistence
      const executionPhase = this.mapStateToExecutionPhase(stateValue);

      console.debug(`[TaskStateManager] Emitting status for ${taskId}:`, {
        status,
        reviewReason,
        xstateState: stateValue,
        executionPhase,
        projectId: project.id
      });

      this.persistStatus(task, project, status, reviewReason, stateValue, executionPhase);
      this.emitStatus(taskId, status, reviewReason, project.id);
      taskHooks.emit('state', { project, task, status, state: stateValue });

      // Only transitions seen while the app runs (not tasks restored in that state)
      const completed = (stateValue === 'human_review' && reviewReason === 'completed') || stateValue === 'done';
      if (completed && lastState !== undefined) this.onTaskCompleted?.(taskId, project);
    });

    actor.start();
    this.actors.set(key, actorEntry);
    return actor;
  }

  private persistStatus(
    task: Task,
    project: Project,
    status: TaskStatus,
    reviewReason?: ReviewReason,
    xstateState?: string,
    executionPhase?: string
  ): void {
    const mainPlanPath = getPlanPath(project, task);
    persistPlanStatusAndReasonSync(mainPlanPath, status, reviewReason, project.id, xstateState, executionPhase);

    const worktreePath = findTaskWorktree(project.path, task.specId);
    if (!worktreePath) return;

    const specsBaseDir = getSpecsDir(project.autoBuildPath);
    const worktreePlanPath = path.join(
      worktreePath,
      specsBaseDir,
      task.specId,
      AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN
    );
    if (existsSync(worktreePlanPath)) {
      persistPlanStatusAndReasonSync(worktreePlanPath, status, reviewReason, project.id, xstateState, executionPhase);
    }
  }

  /**
   * Map XState state to execution phase string
   */
  private mapStateToExecutionPhase(xstateState: string): ExecutionPhase {
    return XSTATE_TO_PHASE[xstateState] || 'idle';
  }

  private emitStatus(
    taskId: string,
    status: TaskStatus,
    reviewReason: ReviewReason | undefined,
    projectId: string
  ): void {
    try {
      this.onStatusChange?.(taskId, status, projectId);
    } catch (error) {
      console.warn(`[TaskStateManager] Status change listener failed for ${taskId}:`, error);
    }
    if (!this.getMainWindow) {
      console.warn(`[TaskStateManager] emitStatus: No main window, cannot emit status ${status} for ${taskId}`);
      return;
    }
    console.debug(`[TaskStateManager] emitStatus: Sending TASK_STATUS_CHANGE for ${taskId}:`, { status, reviewReason, projectId });
    safeSendToRenderer(
      this.getMainWindow,
      IPC_CHANNELS.TASK_STATUS_CHANGE,
      taskId,
      status,
      projectId,
      reviewReason
    );
  }

  private isNewSequence(key: string, sequence: number): boolean {
    const last = this.lastSequenceByTask.get(key);
    // Use >= to accept the first event when sequence equals last (e.g., both are 0)
    // This handles the case where we reload lastSequence from plan file and the next
    // event has the same sequence number (which shouldn't happen, but we should be lenient)
    return last === undefined || sequence >= last;
  }

  private buildSnapshotFromTask(task: Task) {
    const status = task.status;
    const reviewReason = task.reviewReason;
    const executionPhase = task.executionProgress?.phase;
    let stateValue: string = 'backlog';
    let contextReviewReason: ReviewReason | undefined;

    switch (status) {
      case 'in_progress':
        // Use executionProgress.phase to determine if we're in planning or coding
        // This is important because both phases have status 'in_progress'
        if (executionPhase === 'planning') {
          stateValue = 'planning';
        } else if (executionPhase === 'qa_review') {
          stateValue = 'qa_review';
        } else if (executionPhase === 'qa_fixing') {
          stateValue = 'qa_fixing';
        } else {
          // Default to coding for 'coding', 'complete', or unknown phases
          stateValue = 'coding';
        }
        break;
      case 'ai_review':
        stateValue = 'qa_review';
        break;
      case 'human_review':
        stateValue = reviewReason === 'auto_merged' ? 'auto_merged' : 'human_review';
        contextReviewReason = reviewReason;
        break;
      case 'pr_created':
        stateValue = 'pr_created';
        break;
      case 'done':
        stateValue = 'done';
        break;
      case 'error':
        stateValue = 'error';
        contextReviewReason = reviewReason ?? 'errors';
        break;
      case 'queue':
        // Only rate-limit holds are modelled in XState; plain queued tasks start from backlog
        stateValue = task.rateLimitHold ? 'queued' : 'backlog';
        break;
      default:
        stateValue = 'backlog';
        break;
    }

    return taskMachine.resolveState({
      value: stateValue,
      context: {
        reviewReason: contextReviewReason
      }
    });
  }
}

export const taskStateManager = new TaskStateManager();
