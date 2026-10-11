/**
 * Tests for atomic-file module - atomic file operations with retry logic.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import {
  writeFileAtomicSync
} from '../atomic-file';

// Import fs/promises to use in tests
import * as fsPromises from 'fs/promises';
const { mkdir, rm } = fsPromises;

// Test directory for isolated tests
const TEST_DIR = path.join(__dirname, '.test-atomic-file');

describe('writeFileAtomicSync', () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('basic operations', () => {
    it('should write a new file atomically', () => {
      const filePath = path.join(TEST_DIR, 'sync-test.txt');
      const content = 'Hello, sync!';

      writeFileAtomicSync(filePath, content);

      const result = readFileSync(filePath, 'utf-8');
      expect(result).toBe(content);
    });

    it('should overwrite an existing file atomically', () => {
      const filePath = path.join(TEST_DIR, 'sync-existing.txt');
      writeFileSync(filePath, 'Initial content', 'utf-8');

      writeFileAtomicSync(filePath, 'New content');

      const result = readFileSync(filePath, 'utf-8');
      expect(result).toBe('New content');
    });

    it('should write Buffer data', () => {
      const filePath = path.join(TEST_DIR, 'sync-buffer.bin');
      const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);

      writeFileAtomicSync(filePath, buffer);

      const result = readFileSync(filePath);
      expect(result).toEqual(buffer);
    });

    it('should resolve relative paths', () => {
      const absolutePath = path.join(TEST_DIR, 'sync-resolve.txt');
      // Use a relative path that resolves to the same location
      const relativePath = path.relative(process.cwd(), absolutePath);

      writeFileAtomicSync(relativePath, 'resolved content');

      const result = readFileSync(absolutePath, 'utf-8');
      expect(result).toBe('resolved content');
    });
  });

  describe('temp file cleanup', () => {
    it('should not leave temp files after successful write', () => {
      const filePath = path.join(TEST_DIR, 'sync-no-temp.txt');

      writeFileAtomicSync(filePath, 'content');

      const files = readdirSync(TEST_DIR);
      const tempFiles = files.filter(name => name.includes('.tmp.'));
      expect(tempFiles).toHaveLength(0);
    });

    it('should clean up temp file when rename fails', () => {
      // Create a subdirectory as the "target" — renameSync will fail because
      // you can't atomically replace a directory with a file
      const dirTarget = path.join(TEST_DIR, 'is-a-dir');
      mkdirSync(dirTarget);

      expect(() => writeFileAtomicSync(dirTarget, 'content')).toThrow();

      // Verify temp file was cleaned up (it was created in TEST_DIR)
      const files = readdirSync(TEST_DIR);
      const tempFiles = files.filter(name => name.includes('.tmp.'));
      expect(tempFiles).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should throw when directory does not exist', () => {
      const filePath = path.join(TEST_DIR, 'no', 'such', 'dir', 'file.txt');

      expect(() => writeFileAtomicSync(filePath, 'content')).toThrow();
    });
  });
});

