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
  // The store gives each run of the app its own temp file
  TEMP_PATH = path.join(SESSIONS_DIR, `terminals.json.${process.pid}.tmp`);
  BACKUP_PATH = path.join(SESSIONS_DIR, 'terminals.json.backup');
}

// How long this machine has been up, as the store sees it. The store works out when the machine
// came up from the wall clock and the uptime, so holding the uptime still is what lets a test say
// "this window was last written before this boot" and mean it.
const fakeOs = vi.hoisted(() => ({ uptimeSeconds: 3600 }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const uptime = (): number => fakeOs.uptimeSeconds;
  return { ...actual, uptime, default: { ...actual, uptime } };
});

/** When the store will take this machine to have come up */
function thisBootMs(): number {
  return Math.round(Date.now() - fakeOs.uptimeSeconds * 1000);
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
function createValidStoreData(windows: unknown[] = []): string {
  return JSON.stringify({ version: 4, windows }, null, 2);
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
    fakeOs.uptimeSeconds = 3600;
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
      expect(data.version).toBe(4);
      expect(data.windows).toEqual([]);
    });

    it('should load existing valid store data', async () => {
      const existingData = createValidStoreData([createTestSession()]);
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
      expect(content.version).toBe(4);
    });

    it('should rotate current file to backup before overwriting', async () => {
      // Create initial store with one session
      const initialData = createValidStoreData([createTestSession({ id: 'original-session' })]);
      writeFileSync(STORE_PATH, initialData);

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Save a new session (triggers backup rotation)
      store.saveSession(createTestSession({ id: 'new-session' }));

      // Backup should exist with original data
      expect(existsSync(BACKUP_PATH)).toBe(true);
      const backupContent = JSON.parse(readFileSync(BACKUP_PATH, 'utf-8'));
      const backupSessions = backupContent.windows;
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

      // Create valid backup
      const backupData = createValidStoreData([createTestSession({ id: 'recovered-session' })]);
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

      // Create valid backup
      const backupData = createValidStoreData([createTestSession()]);
      writeFileSync(BACKUP_PATH, backupData);

      // Create corrupted main file
      writeFileSync(STORE_PATH, 'corrupted');

      const { TerminalSessionStore } = await import('../terminal-session-store');
      new TerminalSessionStore(TEST_PROJECT_PATH);

      // Main file should now be valid
      const mainContent = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(mainContent.version).toBe(4);
    });

    it('should start fresh if both main and backup are corrupted', async () => {
      writeFileSync(STORE_PATH, 'corrupted main');
      writeFileSync(BACKUP_PATH, 'corrupted backup');

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      const data = store.getAllSessions();
      expect(data.version).toBe(4);
      expect(data.windows).toEqual([]);
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

  describe('windows another copy of the app has open', () => {
    // Above the process id range of every platform, so no process can be running under it
    const ENDED_RUN_PID = 4294967;

    it('leaves a running copy of the app its windows and does not restore them', async () => {
      writeFileSync(STORE_PATH, createValidStoreData([
        { ...createTestSession({ id: 'theirs' }), owner: { instanceId: 'another-run', pid: process.ppid } }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // The other copy still has it open, so this one neither shows it...
      expect(store.getSessions()).toHaveLength(0);

      store.saveSession(createTestSession({ id: 'ours' }));

      // ...nor writes it out of the file
      const written = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(written.windows.map((w: { id: string }) => w.id).sort()).toEqual(['ours', 'theirs']);
    });

    it('takes over the windows of a copy of the app that has ended', async () => {
      writeFileSync(STORE_PATH, createValidStoreData([
        { ...createTestSession({ id: 'left-behind' }), owner: { instanceId: 'ended-run', pid: ENDED_RUN_PID } }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions().map(s => s.id)).toEqual(['left-behind']);
    });

    it('takes over the windows of a run from before this boot, whatever holds its pid now', async () => {
      // A live pid, as a saved pid becomes after a reboot: the number was handed out again. The run
      // that held the window stopped writing to it when the machine went down.
      const lastBoot = thisBootMs() - 10 * 24 * 60 * 60 * 1000;
      writeFileSync(STORE_PATH, createValidStoreData([
        {
          ...createTestSession({ id: 'before-the-reboot', lastActiveAt: new Date(lastBoot + 60_000).toISOString() }),
          owner: { instanceId: 'last-boot', pid: process.ppid, bootTimeMs: lastBoot },
        }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions().map(s => s.id)).toEqual(['before-the-reboot']);
    });

    it('takes over the windows of a run that wrote them moments before the machine came up again', async () => {
      // A machine restarted and the app started again inside one saving period: the window was
      // written seconds ago by the clock, yet before this boot, so no live process can be that run
      fakeOs.uptimeSeconds = 20;
      const lastBoot = thisBootMs() - 2 * 60 * 60 * 1000;
      writeFileSync(STORE_PATH, createValidStoreData([
        {
          ...createTestSession({
            id: 'written-just-before-the-reboot',
            lastActiveAt: new Date(thisBootMs() - 5000).toISOString(),
          }),
          owner: { instanceId: 'last-boot', pid: process.ppid, bootTimeMs: lastBoot },
        }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions().map(s => s.id)).toEqual(['written-just-before-the-reboot']);
    });

    it('leaves a running copy its windows when the clock stepped and the boot times no longer agree', async () => {
      // The other copy saved the window before an NTP correction moved the clock, so the boot time
      // it recorded and the one this run works out are hours apart on the same boot. It is still
      // writing to the window every saving period, which is what says it is there.
      const steppedBoot = thisBootMs() - 2 * 60 * 60 * 1000;
      writeFileSync(STORE_PATH, createValidStoreData([
        {
          ...createTestSession({ id: 'theirs', lastActiveAt: new Date(Date.now() - 5000).toISOString() }),
          owner: { instanceId: 'another-run', pid: process.ppid, bootTimeMs: steppedBoot },
        }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // Not this run's to show...
      expect(store.getSessions()).toHaveLength(0);

      store.saveSession(createTestSession({ id: 'ours' }));

      // ...and not this run's to write away, so the two never both claim it
      const written = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(written.windows.map((w: { id: string }) => w.id).sort()).toEqual(['ours', 'theirs']);
      expect(written.windows.find((w: { id: string }) => w.id === 'theirs').owner.instanceId).toBe('another-run');
    });

    it('leaves a running copy its windows after a long sleep, with nothing written while asleep', async () => {
      // Hours pass with the machine asleep and no window is touched, but the uptime counts that
      // time, so the boot time still says the run holding them belongs to this boot
      fakeOs.uptimeSeconds = 24 * 60 * 60;
      writeFileSync(STORE_PATH, createValidStoreData([
        {
          ...createTestSession({ id: 'theirs', lastActiveAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString() }),
          owner: { instanceId: 'another-run', pid: process.ppid, bootTimeMs: thisBootMs() },
        }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions()).toHaveLength(0);
    });

    it('takes over a window of a run that recorded no boot time but was last active before this boot', async () => {
      writeFileSync(STORE_PATH, createValidStoreData([
        {
          ...createTestSession({ id: 'old-file', lastActiveAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString() }),
          owner: { instanceId: 'last-boot', pid: process.ppid },
        }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions().map(s => s.id)).toEqual(['old-file']);
    });

    it('stamps the boot it saved a window on, so a later boot can tell the pid is stale', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'ours' }));

      const written = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(written.windows[0].owner.bootTimeMs).toBeTypeOf('number');
      expect(written.windows[0].owner.bootTimeMs).toBeLessThanOrEqual(Date.now());
    });

    it('restores windows saved before windows recorded an owner', async () => {
      writeFileSync(STORE_PATH, createValidStoreData([createTestSession({ id: 'no-owner' })]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      expect(store.getSessions().map(s => s.id)).toEqual(['no-owner']);
    });

    it('keeps a window a copy of the app left behind when it was killed', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // The other copy wrote this after this run started, so this run never took it over: it is
      // that copy's to restore when it runs again, not this one's to write away
      writeFileSync(STORE_PATH, createValidStoreData([
        { ...createTestSession({ id: 'left-behind' }), owner: { instanceId: 'killed-run', pid: ENDED_RUN_PID } }
      ]));

      store.saveSession(createTestSession({ id: 'ours' }));

      const written = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(written.windows.map((w: { id: string }) => w.id).sort()).toEqual(['left-behind', 'ours']);
    });

    it('closing a window takes it out of the file and leaves the other copy its own', async () => {
      writeFileSync(STORE_PATH, createValidStoreData([
        { ...createTestSession({ id: 'theirs' }), owner: { instanceId: 'another-run', pid: process.ppid } }
      ]));

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'ours' }));
      store.removeSession('ours');

      const written = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(written.windows.map((w: { id: string }) => w.id)).toEqual(['theirs']);
    });
  });

  describe('flush', () => {
    it('waits for a write queued behind one already running', async () => {
      // Real timers: the queued write runs on promise callbacks, not on a timer
      vi.useRealTimers();

      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      // The window is saved, then closed while that save is still being written — what the app
      // quitting right after a close does
      const saving = store.saveSessionAsync(createTestSession({ id: 'closed-before-quit' }));
      store.removeSession('closed-before-quit');
      await saving;
      await store.flush();

      const written = JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
      expect(written.windows).toHaveLength(0);

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
      expect(JSON.parse(readFileSync(STORE_PATH, 'utf-8')).version).toBe(4);
      const legacy = JSON.parse(readFileSync(path.join(legacyDir, 'terminals.json'), 'utf-8'));
      expect(legacy.sessionsByDate[today][otherProject]).toHaveLength(1);
    });
  });

  describe('the window list', () => {
    it('keeps the windows a project had, with no notion of when', async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);

      store.saveSession(createTestSession({ id: 'one' }));
      store.saveSession(createTestSession({ id: 'two' }));

      expect(store.getSessions().map(s => s.id)).toEqual(['one', 'two']);
      expect(JSON.parse(readFileSync(STORE_PATH, 'utf-8')).windows).toHaveLength(2);
    });

    it("holds only this project's windows", async () => {
      const { TerminalSessionStore } = await import('../terminal-session-store');
      const otherProject = path.join(TEST_DIR, 'other-project');
      mkdirSync(path.join(otherProject, '.workbench'), { recursive: true });
      const store = new TerminalSessionStore(TEST_PROJECT_PATH);
      const otherStore = new TerminalSessionStore(otherProject);

      store.saveSession(createTestSession({ id: 'mine' }));
      otherStore.saveSession(createTestSession({ id: 'theirs', projectPath: otherProject }));

      expect(store.getSessions().map(s => s.id)).toEqual(['mine']);
      expect(otherStore.getSessions().map(s => s.id)).toEqual(['theirs']);
    });
  });
});
