import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, promises as fsPromises } from 'fs';
import type { TerminalWorktreeConfig } from '../shared/types';
import { debugLog } from '../shared/utils/debug-logger';

/**
 * Persisted terminal session data
 */
export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
  projectPath: string;  // Which project this terminal belongs to
  isCLIMode: boolean;
  outputBuffer: string;  // Last 100KB of output for replay
  createdAt: string;  // ISO timestamp
  lastActiveAt: string;  // ISO timestamp
  /** Associated worktree configuration (validated on restore) */
  worktreeConfig?: TerminalWorktreeConfig;
  /** UI display position for ordering terminals after drag-drop */
  displayOrder?: number;
}

/**
 * The windows a project has open, as last seen.
 *
 * The file lives in the project, so it holds that project's windows only: moving or renaming a
 * checkout takes its terminals with it, and no other project can be affected by writing this one.
 * There is no history by date — this is the set to put back on the next start, nothing more.
 */
interface SessionData {
  version: number;
  windows: TerminalSession[];
}

const STORE_VERSION = 4;  // Bumped for the flat window list
const MAX_OUTPUT_BUFFER = 100000;  // 100KB per terminal

/**
 * The windows one project has open, saved to that project's `.workbench/terminals.json`
 */
export class TerminalSessionStore {
  private storePath: string;
  private tempPath: string;
  private backupPath: string;
  private data: SessionData;
  /**
   * Tracks session IDs that are being deleted to prevent async writes from
   * resurrecting them. This fixes a race condition where saveSessionAsync()
   * could complete after removeSession() and re-add deleted sessions.
   */
  private pendingDelete: Set<string> = new Set();
  /**
   * Tracks cleanup timers for pendingDelete entries to prevent timer accumulation
   * when many sessions are deleted rapidly.
   */
  private pendingDeleteTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /**
   * Write serialization state - prevents concurrent async writes from
   * interleaving and potentially losing data.
   */
  private writeInProgress = false;
  private writePending = false;
  /**
   * Failure tracking for async writes - helps detect persistent write issues
   * that might otherwise go unnoticed in fire-and-forget scenarios.
   */
  private consecutiveFailures = 0;
  private static readonly MAX_FAILURES_BEFORE_WARNING = 3;

  constructor(private readonly projectPath: string) {
    const sessionsDir = join(projectPath, '.workbench');
    this.storePath = join(sessionsDir, 'terminals.json');
    this.tempPath = join(sessionsDir, 'terminals.json.tmp');
    this.backupPath = join(sessionsDir, 'terminals.json.backup');

    // `.workbench` existing is what marks a project as initialized, so this never creates it: an
    // uninitialized project keeps its sessions in memory for as long as the app runs
    if (!existsSync(sessionsDir)) {
      console.warn(`[TerminalSessionStore] ${projectPath} is not initialized, so sessions are not persisted`);
    }

    // Load existing data or initialize
    this.data = this.load();
  }

  /**
   * Load sessions from disk with backup recovery
   */
  private load(): SessionData {
    // Try loading from main file first
    const mainResult = this.tryLoadFile(this.storePath);
    if (mainResult.success && mainResult.data) {
      return mainResult.data;
    }

    // If main file failed, try backup
    if (mainResult.error) {
      console.warn('[TerminalSessionStore] Main file corrupted, attempting backup recovery...');
      const backupResult = this.tryLoadFile(this.backupPath);
      if (backupResult.success && backupResult.data) {
        console.warn('[TerminalSessionStore] Successfully recovered from backup!');
        // Immediately save the recovered data to main file
        try {
          writeFileSync(this.storePath, JSON.stringify(backupResult.data, null, 2), 'utf-8');
          console.warn('[TerminalSessionStore] Restored main file from backup');
        } catch (writeError) {
          console.error('[TerminalSessionStore] Failed to restore main file:', writeError);
        }
        return backupResult.data;
      }
      console.error('[TerminalSessionStore] Backup recovery failed, starting fresh');
    }

    return this.importLegacyAppSessions();
  }

  /**
   * Take this project's sessions out of the app-wide file terminals used to share.
   *
   * Runs only when the project has no file of its own, so a user upgrading keeps the terminals they
   * had. The old file is left alone: other projects still need their slice of it.
   */
  private importLegacyAppSessions(): SessionData {
    const empty: SessionData = { version: STORE_VERSION, windows: [] };
    const legacyPath = join(app.getPath('userData'), 'sessions', 'terminals.json');
    if (!existsSync(legacyPath)) return empty;

    try {
      const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as {
        version?: number;
        sessionsByDate?: Record<string, Record<string, TerminalSession[]>>;
      };
      // The app-wide file kept a bucket per day; the most recent one is what was open last
      const byDate = legacy.sessionsByDate ?? {};
      const latest = Object.keys(byDate)
        .filter(date => (byDate[date]?.[this.projectPath]?.length ?? 0) > 0)
        .sort((a, b) => b.localeCompare(a))[0];
      if (!latest) return empty;

      const windows = byDate[latest][this.projectPath];
      console.warn(`[TerminalSessionStore] Imported ${windows.length} window(s) from the app-wide file`);
      const imported: SessionData = { version: STORE_VERSION, windows };
      this.data = imported;
      this.save();
      return imported;
    } catch (error) {
      console.error('[TerminalSessionStore] Could not read the app-wide session file:', error);
      return empty;
    }
  }

  /**
   * Try to load and parse a session file
   */
  private tryLoadFile(filePath: string): { success: boolean; data?: SessionData; error?: Error } {
    try {
      if (!existsSync(filePath)) {
        return { success: false };
      }

      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (data.version === STORE_VERSION) {
        return { success: true, data: data as SessionData };
      }

      console.warn('[TerminalSessionStore] Version mismatch, resetting sessions');
      return { success: false };
    } catch (error) {
      console.error(`[TerminalSessionStore] Error loading ${filePath}:`, error);
      return { success: false, error: error as Error };
    }
  }

  /**
   * Save sessions to disk using atomic write pattern:
   * 1. Write to temp file
   * 2. Rotate current file to backup
   * 3. Rename temp to target (atomic on most filesystems)
   *
   * If an async write is in progress, defers to the async writer to avoid
   * both operations competing for the same temp file (ENOENT race condition).
   */
  private save(): void {
    // If an async write is in progress, don't write synchronously — the async
    // writer shares the same temp file path. Instead, mark a pending write so
    // saveAsync() will re-save with the latest in-memory data when it finishes.
    if (this.writeInProgress) {
      this.writePending = true;
      debugLog('[TerminalSessionStore] Deferring sync save — async write in progress');
      return;
    }

    try {
      const content = JSON.stringify(this.data, null, 2);

      // Step 1: Write to temp file
      writeFileSync(this.tempPath, content, 'utf-8');

      // Step 2: Rotate current file to backup (if it exists and is valid)
      if (existsSync(this.storePath)) {
        try {
          // Verify current file is valid before backing up
          const currentContent = readFileSync(this.storePath, 'utf-8');
          JSON.parse(currentContent); // Throws if invalid
          // Current file is valid, rotate to backup
          if (existsSync(this.backupPath)) {
            unlinkSync(this.backupPath);
          }
          renameSync(this.storePath, this.backupPath);
        } catch {
          // Current file is corrupted, don't back it up - just delete
          console.warn('[TerminalSessionStore] Current file corrupted, not backing up');
          unlinkSync(this.storePath);
        }
      }

      // Step 3: Atomic rename temp to target
      renameSync(this.tempPath, this.storePath);
    } catch (error) {
      console.error('[TerminalSessionStore] Error saving sessions:', error);
      // Clean up temp file if it exists
      try {
        if (existsSync(this.tempPath)) {
          unlinkSync(this.tempPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Helper to check if a file exists asynchronously
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save sessions to disk asynchronously (non-blocking) using atomic write pattern
   *
   * Safe to call from Electron main process without blocking the event loop.
   * Uses write serialization to prevent concurrent writes from losing data.
   * Tracks consecutive failures and logs warnings for persistent issues.
   */
  private async saveAsync(): Promise<void> {
    // If a write is in progress, mark that another write is needed
    if (this.writeInProgress) {
      this.writePending = true;
      return;
    }

    this.writeInProgress = true;
    try {
      const content = JSON.stringify(this.data, null, 2);

      // Step 1: Write to temp file
      await fsPromises.writeFile(this.tempPath, content, 'utf-8');

      // Step 2: Rotate current file to backup (if it exists and is valid)
      if (await this.fileExists(this.storePath)) {
        try {
          const currentContent = await fsPromises.readFile(this.storePath, 'utf-8');
          JSON.parse(currentContent); // Throws if invalid
          // Current file is valid, rotate to backup
          if (await this.fileExists(this.backupPath)) {
            await fsPromises.unlink(this.backupPath);
          }
          await fsPromises.rename(this.storePath, this.backupPath);
        } catch {
          // Current file is corrupted, don't back it up - just delete
          console.warn('[TerminalSessionStore] Current file corrupted, not backing up');
          await fsPromises.unlink(this.storePath);
        }
      }

      // Step 3: Atomic rename temp to target
      await fsPromises.rename(this.tempPath, this.storePath);

      // Reset failure counter on success
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      console.error('[TerminalSessionStore] Error saving sessions:', error);

      // Clean up temp file if it exists
      try {
        if (await this.fileExists(this.tempPath)) {
          await fsPromises.unlink(this.tempPath);
        }
      } catch {
        // Ignore cleanup errors
      }

      // Warn about persistent failures that might indicate a real problem
      if (this.consecutiveFailures >= TerminalSessionStore.MAX_FAILURES_BEFORE_WARNING) {
        console.error(
          `[TerminalSessionStore] WARNING: ${this.consecutiveFailures} consecutive save failures. ` +
          'Session data may not be persisting. Check disk space and permissions.'
        );
      }
    } finally {
      this.writeInProgress = false;

      // If another write was requested while we were writing, do it now
      if (this.writePending) {
        this.writePending = false;
        // Use setImmediate to avoid stack overflow with many rapid calls
        setImmediate(() => this.saveAsync());
      }
    }
  }

  /**
   * The project's windows, as last saved
   */
  private windows(): TerminalSession[] {
    return this.data.windows;
  }

  /**
   * Update session in memory (shared logic for saveSession and saveSessionAsync)
   *
   * Returns false if the session is pending deletion and should not be saved.
   */
  private updateSessionInMemory(session: TerminalSession): boolean {
    // Check if session was deleted - skip if pending deletion
    if (this.pendingDelete.has(session.id)) {
      debugLog('[TerminalSessionStore] Skipping save for deleted session:', session.id,
        'pendingDelete size:', this.pendingDelete.size,
        'all pending IDs:', [...this.pendingDelete].join(', '));
      return false;
    }

    const windows = this.windows();

    // Debug: Log incoming outputBuffer info
    const incomingBufferLen = session.outputBuffer?.length ?? 0;
    debugLog('[TerminalSessionStore] Updating session in memory:', session.id,
      'incoming outputBuffer:', incomingBufferLen, 'bytes',
      'isCLIMode:', session.isCLIMode);

    // Update existing or add new
    const existingIndex = windows.findIndex(s => s.id === session.id);
    if (existingIndex >= 0) {
      // Preserve displayOrder from existing session if not provided in incoming session
      // This prevents periodic saves (which don't include displayOrder) from losing tab order
      const existingSession = windows[existingIndex];
      const existingBufferLen = existingSession.outputBuffer?.length ?? 0;
      const truncatedLen = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER).length;
      debugLog('[TerminalSessionStore] Updating existing session:', session.id,
        'existing outputBuffer:', existingBufferLen, 'bytes',
        'new outputBuffer (after truncation):', truncatedLen, 'bytes');

      windows[existingIndex] = {
        ...session,
        // Limit output buffer size
        outputBuffer: session.outputBuffer.slice(-MAX_OUTPUT_BUFFER),
        lastActiveAt: new Date().toISOString(),
        // Preserve existing displayOrder if incoming session doesn't have it
        displayOrder: session.displayOrder ?? existingSession.displayOrder,
      };
    } else {
      const truncatedLen = session.outputBuffer.slice(-MAX_OUTPUT_BUFFER).length;
      debugLog('[TerminalSessionStore] Creating new session:', session.id,
        'outputBuffer (after truncation):', truncatedLen, 'bytes');

      windows.push({
        ...session,
        outputBuffer: session.outputBuffer.slice(-MAX_OUTPUT_BUFFER),
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString()
      });
    }

    return true;
  }

  /**
   * Save a terminal session (to today's bucket)
   */
  saveSession(session: TerminalSession): void {
    if (this.updateSessionInMemory(session)) {
      this.save();
    }
  }

  /**
   * Validate worktree config - check if the worktree still exists
   * Returns undefined if worktree doesn't exist or is invalid
   */
  private validateWorktreeConfig(config: TerminalWorktreeConfig | undefined): TerminalWorktreeConfig | undefined {
    if (!config) return undefined;

    // Check if the worktree path still exists
    if (!existsSync(config.worktreePath)) {
      console.warn(`[TerminalSessionStore] Worktree path no longer exists: ${config.worktreePath}, clearing config`);
      return undefined;
    }

    return config;
  }

  /**
   * The windows to put back for this project.
   *
   * Validates worktree configs, clearing any whose worktree is gone.
   */
  getSessions(): TerminalSession[] {
    debugLog('[TerminalSessionStore] Getting windows for project:', this.projectPath, 'count:', this.data.windows.length);
    return this.data.windows.map(session => ({
      ...session,
      worktreeConfig: this.validateWorktreeConfig(session.worktreeConfig),
    }));
  }

  /**
   * Get a specific session
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.windows().find(s => s.id === sessionId);
  }

  /**
   * Clear a session ID from pendingDelete, allowing saves to proceed.
   *
   * Called when a terminal is legitimately re-created with the same ID
   * (e.g., worktree switching, terminal restart after exit). Without this,
   * the 5-second pendingDelete window blocks session persistence for the
   * new terminal.
   */
  clearPendingDelete(sessionId: string): void {
    if (this.pendingDelete.has(sessionId)) {
      this.pendingDelete.delete(sessionId);
      // Also clear the cleanup timer since we're explicitly clearing
      const timer = this.pendingDeleteTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.pendingDeleteTimers.delete(sessionId);
      }
      debugLog('[TerminalSessionStore] Cleared pendingDelete for re-created terminal:', sessionId);
    }
  }

  /**
   * Remove a session (from today's sessions)
   *
   * Adds the session ID to pendingDelete to prevent async writes from
   * resurrecting the session if saveSessionAsync() is in-flight.
   */
  removeSession(sessionId: string): void {
    // Mark as pending delete BEFORE modifying data to prevent race condition
    // with in-flight saveSessionAsync() calls
    this.pendingDelete.add(sessionId);
    debugLog('[TerminalSessionStore] removeSession: added to pendingDelete:', sessionId,
      'pendingDelete size:', this.pendingDelete.size,
      'all pending IDs:', [...this.pendingDelete].join(', '));

    const kept = this.data.windows.filter(s => s.id !== sessionId);
    if (kept.length !== this.data.windows.length) {
      this.data.windows = kept;
      this.save();
    }

    // Cancel any existing cleanup timer for this session (prevents timer accumulation
    // when the same session ID is deleted multiple times rapidly)
    const existingTimer = this.pendingDeleteTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Keep the ID in pendingDelete for a short time to handle any in-flight
    // async operations, then clean up to prevent memory leaks
    const timer = setTimeout(() => {
      this.pendingDelete.delete(sessionId);
      this.pendingDeleteTimers.delete(sessionId);
      debugLog('[TerminalSessionStore] Cleanup timer fired for:', sessionId,
        'removing from pendingDelete. Remaining:', this.pendingDelete.size);
    }, 5000);
    this.pendingDeleteTimers.set(sessionId, timer);
  }

  /**
   * Forget every window of this project
   */
  clearProjectSessions(): void {
    this.data.windows = [];
    this.save();
  }

  /**
   * Update output buffer for a session (called frequently, batched save)
   */
  updateOutputBuffer(sessionId: string, output: string): void {
    const session = this.windows().find(s => s.id === sessionId);
    if (session) {
      const prevLen = session.outputBuffer?.length ?? 0;
      session.outputBuffer = (session.outputBuffer + output).slice(-MAX_OUTPUT_BUFFER);
      const newLen = session.outputBuffer.length;
      session.lastActiveAt = new Date().toISOString();

      // Debug: Log buffer update (throttled to avoid spam - only log when significant changes)
      if (newLen - prevLen > 1000 || prevLen === 0) {
        debugLog('[TerminalSessionStore] updateOutputBuffer:', sessionId,
          'prev:', prevLen, 'bytes, added:', output.length, 'bytes, new total:', newLen, 'bytes');
      }
      // Note: We don't save immediately here to avoid excessive disk writes
      // Call saveAllPending() periodically or on app quit
    }
  }

  /**
   * Save all pending changes (call on app quit or periodically)
   */
  saveAllPending(): void {
    this.save();
  }

  /**
   * Update display orders for multiple terminals (after drag-drop reorder).
   * This updates the displayOrder property for matching sessions in today's bucket.
   */
  updateDisplayOrders(orders: Array<{ terminalId: string; displayOrder: number }>): void {
    const sessions = this.windows();

    let hasChanges = false;
    for (const { terminalId, displayOrder } of orders) {
      const session = sessions.find(s => s.id === terminalId);
      if (session && session.displayOrder !== displayOrder) {
        session.displayOrder = displayOrder;
        session.lastActiveAt = new Date().toISOString();
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.save();
    }
  }

  /**
   * Save a terminal session asynchronously (non-blocking)
   *
   * Mirrors saveSession() but uses async disk write to avoid blocking
   * the main process. Use this for fire-and-forget session persistence.
   *
   * Uses shared updateSessionInMemory() which checks pendingDelete to avoid
   * resurrecting sessions that have been removed while this async operation
   * was queued/in-flight.
   */
  async saveSessionAsync(session: TerminalSession): Promise<void> {
    if (this.updateSessionInMemory(session)) {
      await this.saveAsync();
    }
  }

  /**
   * Get all sessions (for debugging)
   */
  getAllSessions(): SessionData {
    return this.data;
  }
}

// One store per project, each backed by that project's own file
const instances = new Map<string, TerminalSessionStore>();

export function getTerminalSessionStore(projectPath: string): TerminalSessionStore {
  let instance = instances.get(projectPath);
  if (!instance) {
    instance = new TerminalSessionStore(projectPath);
    instances.set(projectPath, instance);
  }
  return instance;
}
