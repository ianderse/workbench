import chokidar, { FSWatcher } from 'chokidar';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { ImplementationPlan } from '../shared/types';
import { safeParseJson } from './utils/json-repair';
import { isWslUncPath } from './platform/wsl-paths';
import { appLog } from './app-logger';

interface WatcherInfo {
  taskId: string;
  /** The project the watch was started for, undefined when the caller named none */
  projectId?: string;
  watcher: FSWatcher;
  planPath: string;
}

/**
 * What a `watch()` call that has not finished yet records about itself. The spec dir is what tells
 * a duplicate call from a re-watch; the task and project are kept because a lookup by task id
 * alone has to find this entry without taking the key apart.
 */
interface PendingWatch {
  taskId: string;
  projectId?: string;
  specDir: string;
}

/**
 * Watchers are held per project and task. A task id is its spec id (`001-<slug>`), which every
 * project numbers from its own start, so two projects can be running the same one, each writing
 * its own `implementation_plan.json`. Keyed by the task alone, the second project's `watch()` saw
 * a different spec dir, took itself for a legitimate re-watch and closed the first project's
 * watcher, which stopped that project's progress reaching the renderer; then the first `unwatch()`
 * removed the single remaining entry and neither project got plan updates again.
 *
 * The spec dir is project-specific and would key the watchers just as uniquely, but it cannot be
 * the key: `unwatch()` and the event listeners are reached with a task and a project, not a path,
 * so keying by path would make every one of them rebuild a project's spec path from its settings
 * - the resolving-by-guess this campaign removes - and a watcher keyed by its path still could not
 * say which project it belongs to, which is what the progress and error events now carry.
 *
 * A watch started before its project was known keeps the empty project, exactly as `AgentState`
 * does, so the callers that genuinely have no project id still work.
 */
const watchKey = (taskId: string, projectId?: string): string => `${projectId ?? ''}\u0000${taskId}`;

/**
 * Watches implementation_plan.json files for real-time progress updates.
 *
 * `progress` and `error` are emitted with the project the watch belongs to, so a listener does not
 * have to search the projects for a task id that several of them can hold.
 */
export class FileWatcher extends EventEmitter {
  private watchers: Map<string, WatcherInfo> = new Map();
  // Maps the project and task -> the in-flight watch() call's specDir.
  // Allows re-watch calls with a different specDir to proceed while
  // still preventing duplicate calls for the exact same specDir.
  private pendingWatches: Map<string, PendingWatch> = new Map();
  // Tracks watches that had unwatch() called while watch() was in-flight.
  // Checked after each await point in watch() to avoid creating a leaked watcher.
  private cancelledWatches: Set<string> = new Set();

  /**
   * The key a task's watcher (or in-flight watch) is held under, or undefined when there is none.
   *
   * A caller that names the project gets that project's watcher, and otherwise one stored before
   * any project was known - never another project's. A bare task id still has to answer for
   * callers that have no project, and with a single project watching the task there is nothing to
   * confuse it with. When two projects watch it there is no honest answer, and guessing would
   * close the watcher of a project the caller never meant, so the lookup refuses: the caller sees
   * "not watched", which leaves both projects' progress flowing, instead of silencing one of them.
   *
   * In-flight calls are looked at as well as live watchers, because an `unwatch()` that arrives
   * while a `watch()` is still awaiting has to be able to cancel it - otherwise that watch would
   * install a watcher nothing ever closes.
   */
  private locate(taskId: string, projectId?: string): { key: string | undefined; ambiguous: boolean } {
    const exact = watchKey(taskId, projectId);
    if (this.watchers.has(exact) || this.pendingWatches.has(exact)) return { key: exact, ambiguous: false };
    if (projectId) {
      const projectless = watchKey(taskId, undefined);
      const held = this.watchers.has(projectless) || this.pendingWatches.has(projectless);
      return { key: held ? projectless : undefined, ambiguous: false };
    }

    let found: string | undefined;
    for (const info of this.watchers.values()) {
      if (info.taskId !== taskId) continue;
      const key = watchKey(info.taskId, info.projectId);
      if (found !== undefined && found !== key) return { key: undefined, ambiguous: true };
      found = key;
    }
    for (const pending of this.pendingWatches.values()) {
      if (pending.taskId !== taskId) continue;
      const key = watchKey(pending.taskId, pending.projectId);
      if (found !== undefined && found !== key) return { key: undefined, ambiguous: true };
      found = key;
    }
    return { key: found, ambiguous: false };
  }

  /** The key of the one watcher a read should answer about, or undefined when there is none */
  private resolveKey(taskId: string, projectId: string | undefined, operation: string): string | undefined {
    const { key, ambiguous } = this.locate(taskId, projectId);
    if (ambiguous) {
      appLog.warn(
        `[FileWatcher] ${operation}: ${taskId} is watched in more than one project and no project was named, doing nothing`
      );
    }
    return key;
  }

  /**
   * Start watching a task's implementation plan.
   *
   * `projectId` is the project whose task this is. It travels with the call so that two projects
   * running the same spec id keep a watcher each, and so that the plan updates can say which
   * project they belong to.
   */
  async watch(taskId: string, specDir: string, projectId?: string): Promise<void> {
    const key = watchKey(taskId, projectId);

    // Prevent overlapping watch() calls for the same project, task and specDir combination.
    // Since watch() is async, rapid-fire callers could enter concurrently
    // before the first call updates state, creating duplicate watchers.
    // A call with a different specDir is a legitimate re-watch and is allowed through.
    const pending = this.pendingWatches.get(key);
    if (pending !== undefined && pending.specDir === specDir) {
      return;
    }
    this.pendingWatches.set(key, { taskId, projectId, specDir });

    try {
      // Close any existing watcher for this project and task.
      // Delete from the map BEFORE awaiting close so that a concurrent watch()
      // call entering after the await cannot obtain the same FSWatcher reference
      // and attempt a second close() on the same object.
      const existing = this.watchers.get(key);
      if (existing) {
        this.watchers.delete(key);
        await existing.watcher.close();
      }

      // Check if a newer watch() call has superseded this one while we were awaiting.
      // If the pending specDir changed, another concurrent watch() took over — bail out
      // to avoid overwriting the watcher it is about to create.
      if (this.pendingWatches.get(key)?.specDir !== specDir) {
        return;
      }

      // Check if unwatch() was called while we were awaiting above.
      if (this.cancelledWatches.has(key)) {
        this.cancelledWatches.delete(key);
        return;
      }

      const planPath = path.join(specDir, 'implementation_plan.json');

      // Check if plan file exists
      if (!existsSync(planPath)) {
        this.emit('error', taskId, `Plan file not found: ${planPath}`, projectId);
        return;
      }

      // Create watcher with settings to handle frequent writes. A plan inside WSL
      // (\\wsl.localhost\...) is polled: file system events don't work there
      const watcher = chokidar.watch(planPath, {
        persistent: true,
        ignoreInitial: true,
        ...(isWslUncPath(planPath) ? { usePolling: true, interval: 1000 } : {}),
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      // Check again after the synchronous watcher creation (no await, but defensive).
      if (this.cancelledWatches.has(key)) {
        this.cancelledWatches.delete(key);
        await watcher.close();
        return;
      }

      // Store watcher info
      this.watchers.set(key, {
        taskId,
        projectId,
        watcher,
        planPath
      });

      // Handle file changes
      watcher.on('change', () => {
        try {
          const content = readFileSync(planPath, 'utf-8');
          const plan = safeParseJson<ImplementationPlan>(content);
          if (plan) {
            this.emit('progress', taskId, this.normalizePlanStatuses(plan), projectId);
          }
          // If null, JSON is corrupt even after repair — skip this event
        } catch {
          // File might be in the middle of being written
        }
      });

      // Handle errors
      watcher.on('error', (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.emit('error', taskId, message, projectId);
      });

      // Read and emit initial state
      try {
        const content = readFileSync(planPath, 'utf-8');
        const plan = safeParseJson<ImplementationPlan>(content);
        if (plan) {
          this.emit('progress', taskId, this.normalizePlanStatuses(plan), projectId);
        }
      } catch {
        // Initial read failed - not critical
      }
    } finally {
      // Only clean up if this call still owns the entry. If a superseding
      // concurrent watch() call has already updated pendingWatches with a
      // different specDir, leave that entry intact so the superseding call
      // can proceed correctly.
      if (this.pendingWatches.get(key)?.specDir === specDir) {
        this.pendingWatches.delete(key);
        // The delete above guarantees has() is now false, so there is no
        // longer any in-flight watch() for this project and task. Clear the
        // cancellation flag so it doesn't linger for future watch() calls.
        this.cancelledWatches.delete(key);
      }
    }
  }

  /**
   * Stop watching a task.
   *
   * `projectId` is the project whose watcher to close: without it, stopping one project's run
   * closed whichever watcher carried the task id, and the other project's plan updates stopped
   * with it.
   */
  async unwatch(taskId: string, projectId?: string): Promise<void> {
    const key = this.resolveKey(taskId, projectId, 'unwatch');
    if (key === undefined) return;
    // If watch() is currently in-flight for this project and task, it is already closing the
    // existing watcher. Just set the cancellation flag and return to avoid a
    // double-close of the same FSWatcher.
    if (this.pendingWatches.has(key)) {
      this.cancelledWatches.add(key);
      return;
    }
    const watcherInfo = this.watchers.get(key);
    if (watcherInfo) {
      await watcherInfo.watcher.close();
      this.watchers.delete(key);
    }
  }

  /**
   * Stop all watchers
   */
  async unwatchAll(): Promise<void> {
    // Cancel any in-flight watch() calls so they don't create new watchers
    // after this cleanup completes.
    for (const key of this.pendingWatches.keys()) {
      this.cancelledWatches.add(key);
    }
    this.pendingWatches.clear();
    // Clear cancellation flags now that pendingWatches is empty: the in-flight
    // calls will bail via the supersession check (pendingWatches.get() returns
    // undefined) and will not clean up cancelledWatches themselves. Clearing
    // here ensures the instance is fully reset for subsequent use.
    this.cancelledWatches.clear();
    const closePromises = Array.from(this.watchers.values()).map(
      async (info) => {
        await info.watcher.close();
      }
    );
    await Promise.all(closePromises);
    this.watchers.clear();
  }

  /**
   * Check if a task is being watched
   */
  isWatching(taskId: string, projectId?: string): boolean {
    const key = this.resolveKey(taskId, projectId, 'isWatching');
    return key !== undefined && this.watchers.has(key);
  }

  /**
   * Get the spec directory currently being watched for a task
   */
  getWatchedSpecDir(taskId: string, projectId?: string): string | null {
    const key = this.resolveKey(taskId, projectId, 'getWatchedSpecDir');
    const watcherInfo = key !== undefined ? this.watchers.get(key) : undefined;
    if (!watcherInfo) return null;
    return path.dirname(watcherInfo.planPath);
  }

  /**
   * Get current plan state for a task
   */
  getCurrentPlan(taskId: string, projectId?: string): ImplementationPlan | null {
    const key = this.resolveKey(taskId, projectId, 'getCurrentPlan');
    const watcherInfo = key !== undefined ? this.watchers.get(key) : undefined;
    if (!watcherInfo) return null;

    try {
      const content = readFileSync(watcherInfo.planPath, 'utf-8');
      const plan = safeParseJson<ImplementationPlan>(content);
      if (!plan) return null;
      return this.normalizePlanStatuses(plan);
    } catch {
      return null;
    }
  }

  /**
   * Normalize subtask statuses in a plan.
   * Ensures every subtask has a `status` field, defaulting to 'pending'.
   * This prevents the UI from receiving subtasks with undefined status.
   */
  private normalizePlanStatuses(plan: ImplementationPlan): ImplementationPlan {
    if (!plan.phases || !Array.isArray(plan.phases)) return plan;

    for (const phase of plan.phases) {
      if (!phase.subtasks || !Array.isArray(phase.subtasks)) continue;
      for (const subtask of phase.subtasks) {
        if (!subtask.status) {
          (subtask as { status: string }).status = 'pending';
        }
      }
    }

    return plan;
  }
}

// Singleton instance
export const fileWatcher = new FileWatcher();
