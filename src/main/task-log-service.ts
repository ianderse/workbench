import path from 'path';
import { existsSync, readFileSync, } from 'fs';
import { EventEmitter } from 'events';
import type { TaskLogs, TaskLogPhase, TaskLogStreamChunk, TaskPhaseLog } from '../shared/types';
import { findTaskWorktree } from './worktree-paths';
import { debugLog, debugWarn, debugError } from '../shared/utils/debug-logger';

function findWorktreeSpecDir(projectPath: string, specId: string, specsRelPath: string): string | null {
  const worktreePath = findTaskWorktree(projectPath, specId);
  if (worktreePath) {
    return path.join(worktreePath, specsRelPath, specId);
  }
  return null;
}

/**
 * Service for loading and watching phase-based task logs (task_logs.json)
 *
 * This service provides:
 * - Loading logs from the spec directory (and worktree spec directory when active)
 * - Watching for log file changes
 * - Emitting streaming updates when logs change
 * - Determining which phase is currently active
 *
 * Note: When a task runs in isolated mode (worktrees), the build logs are written to
 * the worktree's spec directory, not the main project's spec directory. This service
 * watches both locations and merges logs from both sources.
 */
class TaskLogService extends EventEmitter {
  private logCache: Map<string, TaskLogs> = new Map();
  // Watches are keyed by spec directory, not spec id: two projects can hold the same spec id
  // (each numbers its tasks from 001), and each window watches its own project's spec
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();
  // Store paths being watched for each spec directory (main + worktree). `watchers` counts
  // the views on it: several windows can watch the same spec, and the poller stops with the last.
  private watchedPaths: Map<string, { mainSpecDir: string; worktreeSpecDir: string | null; specsRelPath: string; specId: string; projectId?: string; watchers: number }> = new Map();

  // Poll interval for watching log changes (more reliable than fs.watch on some systems)
  private readonly POLL_INTERVAL_MS = 1000;

  /**
   * Load task logs from a single spec directory
   * Returns cached logs if the file is corrupted (e.g., mid-write by Python backend)
   */
  loadLogsFromPath(specDir: string): TaskLogs | null {
    const logFile = path.join(specDir, 'task_logs.json');

    debugLog('[TaskLogService.loadLogsFromPath] Attempting to load logs:', {
      specDir,
      logFile,
      exists: existsSync(logFile)
    });

    if (!existsSync(logFile)) {
      debugLog('[TaskLogService.loadLogsFromPath] Log file does not exist:', logFile);
      return null;
    }

    try {
      const content = readFileSync(logFile, 'utf-8');
      const logs = JSON.parse(content) as TaskLogs;

      debugLog('[TaskLogService.loadLogsFromPath] Successfully loaded logs:', {
        specDir,
        specId: logs.spec_id,
        phases: Object.keys(logs.phases),
        entryCounts: {
          planning: logs.phases.planning?.entries?.length || 0,
          coding: logs.phases.coding?.entries?.length || 0,
          validation: logs.phases.validation?.entries?.length || 0
        }
      });

      this.logCache.set(specDir, logs);
      return logs;
    } catch (error) {
      // JSON parse error - file may be mid-write, return cached version if available
      const cached = this.logCache.get(specDir);
      if (cached) {
        debugWarn('[TaskLogService.loadLogsFromPath] Parse error, returning cached logs:', {
          specDir,
          error: error instanceof Error ? error.message : String(error)
        });
        return cached;
      }
      // Only log if we have no cached fallback
      debugError('[TaskLogService.loadLogsFromPath] Failed to load logs (no cache):', {
        logFile,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Merge logs from main and worktree spec directories
   */
  private mergeLogs(mainLogs: TaskLogs | null, worktreeLogs: TaskLogs | null, specDir: string): TaskLogs | null {
    debugLog('[TaskLogService.mergeLogs] Merging logs:', {
      specDir,
      hasMainLogs: !!mainLogs,
      hasWorktreeLogs: !!worktreeLogs,
      mainEntries: mainLogs ? {
        planning: mainLogs.phases.planning?.entries?.length || 0,
        coding: mainLogs.phases.coding?.entries?.length || 0,
        validation: mainLogs.phases.validation?.entries?.length || 0
      } : null,
      worktreeEntries: worktreeLogs ? {
        planning: worktreeLogs.phases.planning?.entries?.length || 0,
        coding: worktreeLogs.phases.coding?.entries?.length || 0,
        validation: worktreeLogs.phases.validation?.entries?.length || 0
      } : null
    });

    if (!worktreeLogs) {
      debugLog('[TaskLogService.mergeLogs] No worktree logs, using main logs only');
      if (mainLogs) {
        this.logCache.set(specDir, mainLogs);
      }
      return mainLogs;
    }

    if (!mainLogs) {
      debugLog('[TaskLogService.mergeLogs] No main logs, using worktree logs only');
      this.logCache.set(specDir, worktreeLogs);
      return worktreeLogs;
    }

    // Merge logs: planning from main, coding/validation from worktree (if available)
    const mergedLogs: TaskLogs = {
      spec_id: mainLogs.spec_id,
      created_at: mainLogs.created_at,
      updated_at: worktreeLogs.updated_at > mainLogs.updated_at ? worktreeLogs.updated_at : mainLogs.updated_at,
      phases: {
        planning: this.combinePhaseLogs(mainLogs.phases.planning, worktreeLogs.phases.planning),
        // Use worktree logs for coding/validation if they have entries, otherwise fall back to main
        coding: (worktreeLogs.phases.coding?.entries?.length > 0 || worktreeLogs.phases.coding?.status !== 'pending')
          ? worktreeLogs.phases.coding
          : mainLogs.phases.coding,
        validation: (worktreeLogs.phases.validation?.entries?.length > 0 || worktreeLogs.phases.validation?.status !== 'pending')
          ? worktreeLogs.phases.validation
          : mainLogs.phases.validation
      }
    };

    debugLog('[TaskLogService.mergeLogs] Merged logs created:', {
      specDir,
      mergedEntries: {
        planning: mergedLogs.phases.planning?.entries?.length || 0,
        coding: mergedLogs.phases.coding?.entries?.length || 0,
        validation: mergedLogs.phases.validation?.entries?.length || 0
      },
      source: {
        planning: 'combined',
        coding: (worktreeLogs.phases.coding?.entries?.length > 0 || worktreeLogs.phases.coding?.status !== 'pending') ? 'worktree' : 'main',
        validation: (worktreeLogs.phases.validation?.entries?.length > 0 || worktreeLogs.phases.validation?.status !== 'pending') ? 'worktree' : 'main'
      }
    });

    this.logCache.set(specDir, mergedLogs);
    return mergedLogs;
  }

  /**
   * Load and merge task logs from main spec dir and worktree spec dir
   * Planning phase logs are in main spec dir, coding/validation logs may be in worktree
   *
   * @param specDir - Main project spec directory
   * @param projectPath - Optional: Project root path (needed to find worktree if not registered)
   * @param specsRelPath - Optional: Relative path to specs (e.g., ".workbench/tasks")
   * @param specId - Optional: Spec ID (needed to find worktree if not registered)
   */
  loadLogs(specDir: string, projectPath?: string, specsRelPath?: string, specId?: string): TaskLogs | null {
    debugLog('[TaskLogService.loadLogs] Loading logs:', {
      specDir,
      projectPath,
      specsRelPath,
      specId,
      watchedPathsCount: this.watchedPaths.size
    });

    // First try to load from main spec dir
    const mainLogs = this.loadLogsFromPath(specDir);

    // Check if we have worktree paths registered for this spec
    const watchedInfo = Array.from(this.watchedPaths.entries()).find(
      ([_, info]) => info.mainSpecDir === specDir
    );

    let worktreeSpecDir: string | null = null;

    if (watchedInfo?.[1].worktreeSpecDir) {
      worktreeSpecDir = watchedInfo[1].worktreeSpecDir;
      debugLog('[TaskLogService.loadLogs] Found worktree from watched paths:', worktreeSpecDir);
    } else if (projectPath && specsRelPath && specId) {
      // Calculate worktree path from provided params
      worktreeSpecDir = findWorktreeSpecDir(projectPath, specId, specsRelPath);
      debugLog('[TaskLogService.loadLogs] Calculated worktree path:', {
        worktreeSpecDir,
        projectPath,
        specId,
        specsRelPath
      });
    }

    if (!worktreeSpecDir) {
      // No worktree info available
      debugLog('[TaskLogService.loadLogs] No worktree found, using main logs only');
      if (mainLogs) {
        this.logCache.set(specDir, mainLogs);
      }
      return mainLogs;
    }

    // Try to load from worktree spec dir
    const worktreeLogs = this.loadLogsFromPath(worktreeSpecDir);

    return this.mergeLogs(mainLogs, worktreeLogs, specDir);
  }

  /**
   * Get the currently active phase from logs
   */
  getActivePhase(specDir: string): TaskLogPhase | null {
    const logs = this.loadLogs(specDir);
    if (!logs) return null;

    const phases: TaskLogPhase[] = ['planning', 'coding', 'validation'];
    for (const phase of phases) {
      if (logs.phases[phase]?.status === 'active') {
        return phase;
      }
    }
    return null;
  }

  /**
   * Get logs for a specific phase
   */
  getPhaseLog(specDir: string, phase: TaskLogPhase): TaskPhaseLog | null {
    const logs = this.loadLogs(specDir);
    if (!logs) return null;
    return logs.phases[phase] || null;
  }

  /**
   * Start watching a spec directory for log changes
   * Also watches the worktree spec directory if it exists (for coding/validation phases)
   *
   * @param specId - The spec ID (e.g., "013-screenshots-on-tasks")
   * @param specDir - Main project spec directory (the watch's identity)
   * @param projectPath - Optional: Project root path (needed to find worktree)
   * @param specsRelPath - Optional: Relative path to specs (e.g., ".workbench/tasks")
   * @param projectId - Optional: Project the spec belongs to, sent with the change events
   */
  startWatching(specId: string, specDir: string, projectPath?: string, specsRelPath?: string, projectId?: string): void {
    debugLog('[TaskLogService.startWatching] Starting watch:', {
      specId,
      specDir,
      projectPath,
      specsRelPath
    });

    // Already watched (another window has it open, or a rapid watch/unwatch cycle): share
    // the poller and count the extra view, so one view closing doesn't freeze the other
    const watched = this.watchedPaths.get(specDir);
    if (watched && this.pollIntervals.has(specDir)) {
      watched.watchers++;
      debugLog('[TaskLogService.startWatching] Already watching this spec, sharing it:', watched.watchers);
      return;
    }

    // A stale poller for the same spec under another directory (the project's paths changed)
    // can no longer be stopped by an unwatch, so drop it here
    this.stopWatchingSpec(specId);

    const mainLogFile = path.join(specDir, 'task_logs.json');

    // Calculate worktree spec directory path if we have project info
    let worktreeSpecDir: string | null = null;
    if (projectPath && specsRelPath) {
      worktreeSpecDir = findWorktreeSpecDir(projectPath, specId, specsRelPath);
    }

    // Store watched paths for this spec directory
    this.watchedPaths.set(specDir, {
      mainSpecDir: specDir,
      worktreeSpecDir,
      specsRelPath: specsRelPath || '',
      specId,
      projectId,
      watchers: 1
    });

    let lastMainContent = '';
    let lastWorktreeContent = '';

    // Initial load from main spec dir
    if (existsSync(mainLogFile)) {
      try {
        lastMainContent = readFileSync(mainLogFile, 'utf-8');
      } catch (_e) {
        // Ignore parse errors on initial load
      }
    }

    // Initial load from worktree spec dir
    if (worktreeSpecDir) {
      const worktreeLogFile = path.join(worktreeSpecDir, 'task_logs.json');
      if (existsSync(worktreeLogFile)) {
        try {
          lastWorktreeContent = readFileSync(worktreeLogFile, 'utf-8');
        } catch (_e) {
          // Ignore parse errors on initial load
        }
      }
    }

    // Do initial merged load
    debugLog('[TaskLogService.startWatching] Loading initial logs');
    const initialLogs = this.loadLogs(specDir);
    if (initialLogs) {
      debugLog('[TaskLogService.startWatching] Initial logs loaded:', {
        specId: initialLogs.spec_id,
        entryCounts: {
          planning: initialLogs.phases.planning?.entries?.length || 0,
          coding: initialLogs.phases.coding?.entries?.length || 0,
          validation: initialLogs.phases.validation?.entries?.length || 0
        }
      });
      this.logCache.set(specDir, initialLogs);
    } else {
      debugLog('[TaskLogService.startWatching] No initial logs found');
    }

    // Poll for changes in both locations
    // Note: worktreeSpecDir may be null initially if worktree doesn't exist yet.
    // We need to dynamically re-discover it during polling.
    const pollInterval = setInterval(() => {
      let mainChanged = false;
      let worktreeChanged = false;

      // Dynamically re-discover worktree if not found yet
      // This handles the case where user opens logs before worktree is created
      const watchedInfo = this.watchedPaths.get(specDir);
      let currentWorktreeSpecDir = watchedInfo?.worktreeSpecDir || null;

      if (!currentWorktreeSpecDir && projectPath && specsRelPath) {
        const discoveredWorktree = findWorktreeSpecDir(projectPath, specId, specsRelPath);
        if (discoveredWorktree) {
          currentWorktreeSpecDir = discoveredWorktree;
          // Update stored paths so future iterations don't need to re-discover
          this.watchedPaths.set(specDir, {
            ...watchedInfo,
            mainSpecDir: specDir,
            worktreeSpecDir: discoveredWorktree,
            specsRelPath: specsRelPath,
            specId,
            projectId,
            watchers: watchedInfo?.watchers ?? 1
          });
          debugLog('[TaskLogService] Discovered worktree for spec:', {
            specId,
            worktreeSpecDir: discoveredWorktree
          });
        }
      }

      // Check main spec dir
      if (existsSync(mainLogFile)) {
        try {
          const currentContent = readFileSync(mainLogFile, 'utf-8');
          if (currentContent !== lastMainContent) {
            lastMainContent = currentContent;
            mainChanged = true;
          }
        } catch (_error) {
          // Ignore read/parse errors
        }
      }

      // Check worktree spec dir
      if (currentWorktreeSpecDir) {
        const worktreeLogFile = path.join(currentWorktreeSpecDir, 'task_logs.json');
        if (existsSync(worktreeLogFile)) {
          try {
            const currentContent = readFileSync(worktreeLogFile, 'utf-8');
            if (currentContent !== lastWorktreeContent) {
              lastWorktreeContent = currentContent;
              worktreeChanged = true;
            }
          } catch (_error) {
            // Ignore read/parse errors
          }
        }
      }

      // If either file changed, reload and emit
      if (mainChanged || worktreeChanged) {
        debugLog('[TaskLogService] Log file changed:', {
          specId,
          mainChanged,
          worktreeChanged
        });

        const previousLogs = this.logCache.get(specDir);
        const logs = this.loadLogs(specDir);

        if (logs) {
          debugLog('[TaskLogService] Emitting logs-changed event:', {
            specId,
            entryCounts: {
              planning: logs.phases.planning?.entries?.length || 0,
              coding: logs.phases.coding?.entries?.length || 0,
              validation: logs.phases.validation?.entries?.length || 0
            }
          });

          // Emit change event with the merged logs; the project keeps the event out of
          // other projects' windows
          this.emit('logs-changed', specId, logs, projectId);

          // Calculate and emit streaming updates for new entries
          this.emitNewEntries(specId, previousLogs, logs, projectId);
        } else {
          debugWarn('[TaskLogService] No logs loaded after file change:', specId);
        }
      }
    }, this.POLL_INTERVAL_MS);

    this.pollIntervals.set(specDir, pollInterval);
    debugLog('[TaskLogService] Started watching spec:', {
      specId,
      mainSpecDir: specDir,
      worktreeSpecDir: worktreeSpecDir || 'none',
      pollIntervalMs: this.POLL_INTERVAL_MS
    });
  }

  /**
   * Drop one view of a spec directory; the poller stops with the last one.
   */
  stopWatching(specDir: string): void {
    const watched = this.watchedPaths.get(specDir);
    if (watched && watched.watchers > 1) {
      watched.watchers--;
      debugLog('[TaskLogService.stopWatching] Another view still watching:', watched.watchers);
      return;
    }
    this.clearWatch(specDir);
  }

  /** Stop watching a spec wherever it is watched from (its project is gone, or moved) */
  stopWatchingSpec(specId: string): void {
    for (const [specDir, watched] of [...this.watchedPaths]) {
      if (watched.specId === specId) this.clearWatch(specDir);
    }
  }

  private clearWatch(specDir: string): void {
    const interval = this.pollIntervals.get(specDir);
    if (interval) {
      debugLog('[TaskLogService.stopWatching] Stopping watch for spec dir:', specDir);
      clearInterval(interval);
      this.pollIntervals.delete(specDir);
    }
    this.watchedPaths.delete(specDir);
  }

  /**
   * Stop all watches
   */
  stopAllWatching(): void {
    for (const specDir of [...this.pollIntervals.keys()]) {
      this.clearWatch(specDir);
    }
  }

  /**
   * Combine entries from two phase log sources.
   * Used for the planning phase where spec creation logs (main) and
   * planner agent logs (worktree) should both appear.
   */
  private combinePhaseLogs(main: TaskPhaseLog | undefined, worktree: TaskPhaseLog | undefined): TaskPhaseLog {
    // If only one has entries, use it
    if (!main?.entries?.length && !worktree?.entries?.length) {
      return main || worktree || { phase: 'planning' as TaskLogPhase, status: 'pending', started_at: null, completed_at: null, entries: [] };
    }
    if (!main?.entries?.length) return worktree!;
    if (!worktree?.entries?.length) return main;

    // Combine entries from both, sorted by timestamp
    const allEntries = [...main.entries, ...worktree.entries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Deduplicate: entries with identical timestamp + type + content are considered duplicates.
    // This happens when task_logs.json is copied from main to worktree (worktree-manager Step 7),
    // causing both dirs to contain the same planning phase entries.
    const seen = new Set<string>();
    const deduped = allEntries.filter(entry => {
      const key = `${entry.timestamp}|${entry.type}|${entry.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const combined: TaskPhaseLog = {
      phase: main.phase,
      // Use the most advanced status (worktree typically has the later state)
      status: worktree.status !== 'pending' ? worktree.status : main.status,
      started_at: main.started_at || worktree.started_at,
      completed_at: worktree.completed_at || main.completed_at,
      entries: deduped,
    };
    return combined;
  }

  /**
   * Emit streaming updates for new log entries
   */
  private emitNewEntries(specId: string, previousLogs: TaskLogs | undefined, currentLogs: TaskLogs, projectId?: string): void {
    const phases: TaskLogPhase[] = ['planning', 'coding', 'validation'];

    for (const phase of phases) {
      const prevPhase = previousLogs?.phases[phase];
      const currPhase = currentLogs.phases[phase];

      if (!currPhase) continue;

      // Check for phase status changes
      if (prevPhase?.status !== currPhase.status) {
        if (currPhase.status === 'active') {
          this.emit('stream-chunk', specId, {
            type: 'phase_start',
            phase,
            timestamp: currPhase.started_at || new Date().toISOString()
          } as TaskLogStreamChunk, projectId);
        } else if (currPhase.status === 'completed' || currPhase.status === 'failed' || currPhase.status === 'stopped') {
          this.emit('stream-chunk', specId, {
            type: 'phase_end',
            phase,
            timestamp: currPhase.completed_at || new Date().toISOString()
          } as TaskLogStreamChunk, projectId);
        }
      }

      // Check for new entries
      const prevEntryCount = prevPhase?.entries.length || 0;
      const currEntryCount = currPhase.entries.length;

      if (currEntryCount > prevEntryCount) {
        // Emit new entries
        for (let i = prevEntryCount; i < currEntryCount; i++) {
          const entry = currPhase.entries[i];

          const streamUpdate: TaskLogStreamChunk = {
            type: entry.type as TaskLogStreamChunk['type'],
            content: entry.content,
            phase: entry.phase,
            timestamp: entry.timestamp,
            subtask_id: entry.subtask_id
          };

          if (entry.tool_name) {
            streamUpdate.tool = {
              name: entry.tool_name,
              input: entry.tool_input
            };
          }

          this.emit('stream-chunk', specId, streamUpdate, projectId);
        }
      }
    }
  }

  /**
   * Get cached logs without re-reading from disk
   */
  getCachedLogs(specDir: string): TaskLogs | null {
    return this.logCache.get(specDir) || null;
  }

  /**
   * Clear the log cache for a spec
   */
  clearCache(specDir: string): void {
    this.logCache.delete(specDir);
  }

  /**
   * Check if logs exist for a spec
   */
  hasLogs(specDir: string): boolean {
    const logFile = path.join(specDir, 'task_logs.json');
    return existsSync(logFile);
  }
}

// Singleton instance
export const taskLogService = new TaskLogService();
