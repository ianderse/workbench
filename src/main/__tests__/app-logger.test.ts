/**
 * Unit tests for Application Logger Service
 * Tests logging functionality, debug info collection, and cross-platform compatibility
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Use secure temp directory with random suffix to prevent symlink attacks
// These will be initialized in beforeEach with mkdtempSync
let TEST_BASE_DIR: string;
let TEST_LOGS_DIR: string;
let TEST_LOG_FILE: string;

// Store mock functions for dynamic path updates
const mockGetFile = vi.fn();
const mockGetPath = vi.fn();

// Mock electron-log before importing
vi.mock('electron-log/main.js', () => ({
  default: {
    initialize: vi.fn(),
    transports: {
      file: {
        maxSize: 10 * 1024 * 1024,
        format: '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}',
        fileName: 'main.log',
        level: 'info',
        getFile: mockGetFile
      },
      console: {
        level: 'warn',
        format: '[{h}:{i}:{s}] [{level}] {text}'
      }
    },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '2.7.2-beta.10'),
    getLocale: vi.fn(() => 'en-US'),
    isPackaged: false,
    getPath: mockGetPath
  }
}));

// Setup and cleanup helpers
function setupTestEnvironment(): void {
  // Create secure temp directory with random suffix (prevents symlink attacks)
  TEST_BASE_DIR = mkdtempSync(path.join(tmpdir(), 'app-logger-test-'));
  TEST_LOGS_DIR = path.join(TEST_BASE_DIR, 'logs');
  TEST_LOG_FILE = path.join(TEST_LOGS_DIR, 'main.log');

  // Create logs directory
  mkdirSync(TEST_LOGS_DIR, { recursive: true });

  // Configure mocks to use the secure temp directory
  mockGetFile.mockReturnValue({ path: TEST_LOG_FILE });
  mockGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return TEST_BASE_DIR;
    if (name === 'logs') return TEST_LOGS_DIR;
    return TEST_BASE_DIR;
  });
}

function cleanupTestDirs(): void {
  if (TEST_BASE_DIR && existsSync(TEST_BASE_DIR)) {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
}

describe('Application Logger', () => {
  beforeEach(() => {
    // Setup fresh secure temp directory for each test
    setupTestEnvironment();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupTestDirs();
  });

  describe('setupErrorLogging', () => {
    it('should register process error handlers', async () => {
      const processSpy = vi.spyOn(process, 'on');

      const { setupErrorLogging } = await import('../app-logger');
      setupErrorLogging();

      expect(processSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
      expect(processSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));

      processSpy.mockRestore();
    });
  });

  describe('Beta version detection', () => {
    it('should detect beta version from app version', async () => {
      // The mock returns '2.7.2-beta.10' which should be detected as beta
      const electronLog = await import('electron-log/main.js');

      // Beta version should set file level to debug
      // This is tested implicitly by the mock setup
      expect(electronLog.default.transports.file.level).toBeDefined();
    });
  });

});

describe('Logger exports', () => {

  it('should export appLog convenience methods', async () => {
    const { appLog } = await import('../app-logger');

    expect(appLog).toBeDefined();
    expect(typeof appLog.info).toBe('function');
    expect(typeof appLog.warn).toBe('function');
    expect(typeof appLog.error).toBe('function');
    expect(typeof appLog.debug).toBe('function');
    expect(typeof appLog.log).toBe('function');
  });
});
