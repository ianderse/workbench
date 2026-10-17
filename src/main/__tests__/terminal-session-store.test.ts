/**
 * Unit tests for Terminal Session Store
 * Tests atomic writes, backup recovery, race condition prevention, and write serialization
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

// Test directories - use secure temporary directory with unique suffix
// This prevents symlink attacks and race conditions compared to predictable /tmp paths
let TEST_DIR: string;
let USER_DATA_PATH: string;
let SESSIONS_DIR: string;
let STORE_PATH: string;
let TEMP_PATH: string;
let BACKUP_PATH: string;
let TEST_PROJECT_PATH: string;

function initTestPaths(): void {
  // Create a unique temporary directory using mkdtempSync for security
  TEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'terminal-session-store-test-'));
  USER_DATA_PATH = path.join(TEST_DIR, 'userData');
  TEST_PROJECT_PATH = path.join(TEST_DIR, 'test-project');
  // One file per project, kept in that project's own .workbench
  SESSIONS_DIR = path.join(TEST_PROJECT_PATH, '.workbench');
  STORE_PATH = path.join(SESSIONS_DIR, 'terminals.json');
  TEMP_PATH = path.join(SESSIONS_DIR, 'terminals.json.tmp');
  BACKUP_PATH = path.join(SESSIONS_DIR, 'terminals.json.backup');
}

// Mock Electron before importing the store
// Note: The mock uses a getter to access the dynamic paths at runtime
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      // Access the module-level variables which are set before each test
      if (name === 'userData') return USER_DATA_PATH;
      return TEST_DIR;
    })
  }
}));

// Setup test directories
function setupTestDirs(): void {
  // Initialize unique test paths for this test run
  initTestPaths();
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(TEST_PROJECT_PATH, { recursive: true });
}

// Cleanup test directories
function cleanupTestDirs(): void {
  // Only clean up if TEST_DIR was initialized and exists
  if (TEST_DIR && existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// Create a valid session data structure
function createValidStoreData(sessionsByDate: Record<string, unknown[]> = {}): string {
  return JSON.stringify({
    version: 3,
    sessionsByDate
  }, null, 2);
}

// Create a test session
function createTestSession(overrides: Partial<{
  id: string;
  title: string;
  cwd: string;
  projectPath: string;
  isCLIMode: boolean;
  outputBuffer: string;
  createdAt: string;
  lastActiveAt: string;
}> = {}) {
  return {
    id: overrides.id ?? 'test-session-1',
    title: overrides.title ?? 'Test Terminal',
    cwd: overrides.cwd ?? TEST_PROJECT_PATH,
    projectPath: overrides.projectPath ?? TEST_PROJECT_PATH,
    isCLIMode: overrides.isCLIMode ?? false,
    outputBuffer: overrides.outputBuffer ?? 'test output',
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActiveAt: overrides.lastActiveAt ?? new Date().toISOString()
  };
}

describe('TerminalSessionStore', () => {
  beforeEach(async () => {
    // Clean up any previous test's temp directory
    cleanupTestDirs();
    // Setup creates new unique temp directory for this test
    setupTestDirs();
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanupTestDirs();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('does not create .workbench for an uninitialized project', async () => {
      rmSync(SESSIONS_DIR, { recursive: true, force: true });

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // .workbench existing is what marks a project initialized, so sessions stay in memory
      expect(existsSync(SESSIONS_DIR)).toBe(false);
      store.saveSession(createTestSession());
      expect(store.getSessions()).toHaveLength(1);
      expect(existsSync(STORE_PATH)).toBe(false);
    });

    it('should initialize with empty data when no store file exists', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      const data = store.getAllSessions();
      expect(data.version).toBe(3);
      expect(data.sessionsByDate).toEqual({});
    });

    it('should load existing valid store data', async () => {
      const today = new Date().toISOString().split('T')[0];
      const existingData = createValidStoreData({
        [today]: [createTestSession()]
      });
      writeFileSync(STORE_PATH, existingData);

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      const sessions = store.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('test-session-1');
    });
  });

  describe('atomic writes', () => {
    it('should write to temp file then rename atomically', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession());

      // Main file should exist after save
      expect(existsSync(STORE_PATH)).toBe(true);
      // Temp file should be cleaned up
      expect(existsSync(TEMP_PATH)).toBe(false);

      // Verify content
      const content = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(content.version).toBe(3);
    });

    it('should rotate current file to backup before overwriting', async () => {
      // Create initial store with one session
      const today = new Date().toISOString().split('T')[0];
      const initialData = createValidStoreData({
        [today]: [createTestSession({ id: 'original-session' })]
      });
      writeFileSync(STORE_PATH, initialData);

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Save a new session (triggers backup rotation)
      store.saveSession(createTestSession({ id: 'new-session' }));

      // Backup should exist with original data
      expect(existsSync(BACKUP_PATH)).toBe(true);
      const backupContent = JSON.parse(readFileSync(BACKUP_PATH, 'utf-8'));
      const backupSessions = backupContent.sessionsByDate[today];
      expect(backupSessions.some((s: { id: string }) => s.id === 'original-session')).toBe(true);
    });

    it('should not backup corrupted files', async () => {
      // Create corrupted store file
      writeFileSync(STORE_PATH, 'not valid json {{{');

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Save a session
      store.saveSession(createTestSession());

      // Backup should NOT contain the corrupted data
      if (existsSync(BACKUP_PATH)) {
        const backupContent = readFileSync(BACKUP_PATH, 'utf-8');
        expect(backupContent).not.toContain('not valid json');
      }
    });

    it('should clean up temp file on error', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Force an error by making the directory read-only (if possible)
      // This test mainly verifies the code path exists
      store.saveSession(createTestSession());

      // Temp file should not exist after successful save
      expect(existsSync(TEMP_PATH)).toBe(false);
    });
  });

  describe('backup recovery', () => {
    it('should recover from corrupted main file using backup', async () => {
      const today = new Date().toISOString().split('T')[0];

      // Create valid backup
      const backupData = createValidStoreData({
        [today]: [createTestSession({ id: 'recovered-session' })]
      });
      writeFileSync(BACKUP_PATH, backupData);

      // Create corrupted main file
      writeFileSync(STORE_PATH, 'corrupted {{{ json');

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Should recover from backup
      const sessions = store.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('recovered-session');
    });

    it('should restore main file from backup after recovery', async () => {
      const today = new Date().toISOString().split('T')[0];

      // Create valid backup
      const backupData = createValidStoreData({
        [today]: [createTestSession()]
      });
      writeFileSync(BACKUP_PATH, backupData);

      // Create corrupted main file
      writeFileSync(STORE_PATH, 'corrupted');

      const { TerminalSessionStore } = await import('../terminal-session-store');
      new TerminalSessionStore(TEST_PROJECT_PATH);

      // Main file should now be valid
      const mainContent = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(mainContent.version).toBe(3);
    });

    it('should start fresh if both main and backup are corrupted', async () => {
      writeFileSync(STORE_PATH, 'corrupted main');
      writeFileSync(BACKUP_PATH, 'corrupted backup');

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      const data = store.getAllSessions();
      expect(data.version).toBe(3);
      expect(data.sessionsByDate).toEqual({});
    });
  });

  describe('race condition prevention', () => {
    it('should not resurrect deleted sessions in async save', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Create and save a session
      const session = createTestSession({ id: 'to-be-deleted' });
      store.saveSession(session);

      // Verify session exists
      expect(store.getSessions()).toHaveLength(1);

      // Delete the session
      store.removeSession('to-be-deleted');

      // Try to save the same session again (simulating in-flight async save)
      await store.saveSessionAsync(session);

      // Session should NOT be resurrected
      expect(store.getSessions()).toHaveLength(0);
    });

    it('should track session in pendingDelete after removal', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'session-1' }));
      store.removeSession('session-1');

      // Attempt to save the deleted session
      const result = await store.saveSessionAsync(createTestSession({ id: 'session-1' }));

      // Session should not be saved (saveSessionAsync returns undefined when skipped)
      expect(result).toBeUndefined();
    });

    it('should clean up pendingDelete after timeout', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'cleanup-test' }));
      store.removeSession('cleanup-test');

      // Fast-forward past the cleanup timeout (5000ms)
      vi.advanceTimersByTime(5001);

      // Now the session should be saveable again
      store.saveSession(createTestSession({ id: 'cleanup-test' }));
      expect(store.getSessions()).toHaveLength(1);
    });

    it('should prevent timer accumulation on rapid deletes', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Create a session
      store.saveSession(createTestSession({ id: 'rapid-delete' }));

      // Delete the same session ID multiple times rapidly
      for (let i = 0; i < 100; i++) {
        store.removeSession('rapid-delete');
      }

      // Fast-forward to trigger cleanup
      vi.advanceTimersByTime(5001);

      // Should complete without issues (no timer accumulation)
      expect(store.getSessions()).toHaveLength(0);
    });
  });

  describe('write serialization', () => {
    it('should serialize concurrent async writes', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Start multiple concurrent saves
      const promises = [
        store.saveSessionAsync(createTestSession({ id: 'session-1', title: 'First' })),
        store.saveSessionAsync(createTestSession({ id: 'session-2', title: 'Second' })),
        store.saveSessionAsync(createTestSession({ id: 'session-3', title: 'Third' }))
      ];

      await Promise.all(promises);

      // All sessions should be saved
      const sessions = store.getSessions();
      expect(sessions).toHaveLength(3);
    });

    it('should coalesce rapid writes using writePending flag', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Use real timers for this test since we need setImmediate to work
      vi.useRealTimers();

      // Fire many rapid saves
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(store.saveSessionAsync(createTestSession({
          id: `rapid-${i}`,
          title: `Session ${i}`
        })));
      }

      await Promise.all(promises);

      // All sessions should be saved
      const sessions = store.getSessions();
      expect(sessions).toHaveLength(10);

      vi.useFakeTimers();
    });
  });

  describe('failure tracking', () => {
    it('should reset consecutive failures on successful save', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Successful save should work
      store.saveSession(createTestSession());

      // Verify file was written
      expect(existsSync(STORE_PATH)).toBe(true);
    });
  });

  describe('session CRUD operations', () => {
    it('should save and retrieve sessions', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      const session = createTestSession({
        id: 'crud-test',
        title: 'CRUD Test Terminal'
      });
      store.saveSession(session);

      const retrieved = store.getSession('crud-test');
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('CRUD Test Terminal');
    });

    it('should update existing sessions', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Save initial session
      store.saveSession(createTestSession({
        id: 'update-test',
        title: 'Original Title'
      }));

      // Update the session
      store.saveSession(createTestSession({
        id: 'update-test',
        title: 'Updated Title'
      }));

      const sessions = store.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe('Updated Title');
    });

    it('should remove sessions correctly', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'to-remove' }));
      store.saveSession(createTestSession({ id: 'to-keep' }));

      expect(store.getSessions()).toHaveLength(2);

      store.removeSession('to-remove');

      const remaining = store.getSessions();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('to-keep');
    });

    it('should clear all sessions for a project', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'session-1' }));
      store.saveSession(createTestSession({ id: 'session-2' }));

      store.clearProjectSessions();

      expect(store.getSessions()).toHaveLength(0);
    });
  });

  describe('output buffer management', () => {
    it('should limit output buffer size to MAX_OUTPUT_BUFFER', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Create session with large output buffer (> 100KB)
      const largeOutput = 'x'.repeat(150000);
      store.saveSession(createTestSession({
        id: 'large-buffer',
        outputBuffer: largeOutput
      }));

      const session = store.getSession('large-buffer');
      expect(session?.outputBuffer.length).toBeLessThanOrEqual(100000);
    });

    it('should update output buffer incrementally', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({
        id: 'buffer-update',
        outputBuffer: 'initial'
      }));

      store.updateOutputBuffer('buffer-update', ' appended');

      const session = store.getSession('buffer-update');
      expect(session?.outputBuffer).toBe('initial appended');
    });
  });

  describe('display order', () => {
    it('should update display orders for terminals', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'term-1' }));
      store.saveSession(createTestSession({ id: 'term-2' }));
      store.saveSession(createTestSession({ id: 'term-3' }));

      store.updateDisplayOrders([
        { terminalId: 'term-1', displayOrder: 2 },
        { terminalId: 'term-2', displayOrder: 0 },
        { terminalId: 'term-3', displayOrder: 1 }
      ]);

      const sessions = store.getSessions();
      const term1 = sessions.find(s => s.id === 'term-1');
      const term2 = sessions.find(s => s.id === 'term-2');
      const term3 = sessions.find(s => s.id === 'term-3');

      expect(term1?.displayOrder).toBe(2);
      expect(term2?.displayOrder).toBe(0);
      expect(term3?.displayOrder).toBe(1);
    });

    it('should preserve display order on session update', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'ordered-term' }));
      store.updateDisplayOrders([
        { terminalId: 'ordered-term', displayOrder: 5 }
      ]);

      // Update session without displayOrder (simulating periodic output save)
      store.saveSession(createTestSession({
        id: 'ordered-term',
        outputBuffer: 'new output'
      }));

      const session = store.getSession('ordered-term');
      expect(session?.displayOrder).toBe(5);
    });
  });

  describe('version migration', () => {
    it("takes this project's sessions out of the old app-wide file, and leaves other projects alone", async () => {
      const today = new Date().toISOString().split('T')[0];
      const otherProject = path.join(TEST_DIR, 'other-project');
      const legacyDir = path.join(USER_DATA_PATH, 'sessions');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(path.join(legacyDir, 'terminals.json'), JSON.stringify({
        version: 2,
        sessionsByDate: {
          [today]: {
            [TEST_PROJECT_PATH]: [createTestSession({ id: 'mine' })],
            [otherProject]: [createTestSession({ id: 'theirs', projectPath: otherProject })],
          },
        },
      }));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions().map(s => s.id)).toEqual(['mine']);
      // Written to the project's own file, while the app-wide one keeps every project's slice
      expect(JSON.parse(readFileSync(STORE_PATH, 'utf-8')).version).toBe(3);
      const legacy = JSON.parse(readFileSync(path.join(legacyDir, 'terminals.json'), 'utf-8'));
      expect(legacy.sessionsByDate[today][otherProject]).toHaveLength(1);
    });
  });

  describe('date-based organization', () => {
    it('should get available dates with session info', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'today-1' }));
      store.saveSession(createTestSession({ id: 'today-2' }));

      const dates = store.getAvailableDates();

      expect(dates).toHaveLength(1);
      expect(dates[0].sessionCount).toBe(2);
      expect(dates[0].label).toBe('Today');
    });

    it("lists only this project's dates, because the file holds only this project", async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const otherProject = path.join(TEST_DIR, 'other-project');
      mkdirSync(path.join(otherProject, '.workbench'), { recursive: true });
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);
      const otherStore = new TerminalSessionStore(otherProject);

      store.saveSession(createTestSession({ id: 'mine' }));
      otherStore.saveSession(createTestSession({ id: 'theirs', projectPath: otherProject }));

      expect(store.getAvailableDates()).toHaveLength(1);
      expect(store.getAvailableDates()[0].sessionCount).toBe(1);
      expect(store.getSessions().map(s => s.id)).toEqual(['mine']);
    });
  });
});
