/**
 * Platform Module Tests
 *
 * Tests platform abstraction layer using mocks to simulate
 * different operating systems.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getPathDelimiter,
  getExecutableExtension,
  requiresShell,
  joinPaths
} from '../index.js';

// Mock process.platform
const originalPlatform = process.platform;

function mockPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    writable: true,
    configurable: true
  });
}

describe('Platform Module', () => {
  afterEach(() => {
    mockPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  describe('Path Delimiter', () => {
    it('returns semicolon on Windows', () => {
      mockPlatform('win32');
      expect(getPathDelimiter()).toBe(';');
    });

    it('returns colon on Unix', () => {
      mockPlatform('darwin');
      expect(getPathDelimiter()).toBe(':');
    });
  });

  describe('Executable Extension', () => {
    it('returns .exe on Windows', () => {
      mockPlatform('win32');
      expect(getExecutableExtension()).toBe('.exe');
    });

    it('returns empty string on Unix', () => {
      mockPlatform('darwin');
      expect(getExecutableExtension()).toBe('');
    });
  });

  describe('requiresShell', () => {
    it('returns true for .cmd files on Windows', () => {
      mockPlatform('win32');
      expect(requiresShell('npm.cmd')).toBe(true);
      expect(requiresShell('script.cmd')).toBe(true);
    });

    it('returns true for .bat files on Windows', () => {
      mockPlatform('win32');
      expect(requiresShell('script.bat')).toBe(true);
      expect(requiresShell('run.bat')).toBe(true);
    });

    it('returns true for .ps1 files on Windows', () => {
      mockPlatform('win32');
      expect(requiresShell('script.ps1')).toBe(true);
      expect(requiresShell('setup.ps1')).toBe(true);
    });

    it('returns false for .exe files on Windows', () => {
      mockPlatform('win32');
      expect(requiresShell('node.exe')).toBe(false);
      expect(requiresShell('claude.exe')).toBe(false);
    });

    it('returns false for executables without extension on Windows', () => {
      mockPlatform('win32');
      expect(requiresShell('node')).toBe(false);
    });

    it('returns false on macOS regardless of extension', () => {
      mockPlatform('darwin');
      expect(requiresShell('npm')).toBe(false);
      expect(requiresShell('script.sh')).toBe(false);
      expect(requiresShell('node')).toBe(false);
    });

    it('returns false on Linux regardless of extension', () => {
      mockPlatform('linux');
      expect(requiresShell('npm')).toBe(false);
      expect(requiresShell('script.sh')).toBe(false);
      expect(requiresShell('node')).toBe(false);
    });

    it('handles case-insensitive extensions on Windows', () => {
      mockPlatform('win32');
      expect(requiresShell('script.CMD')).toBe(true);
      expect(requiresShell('script.Cmd')).toBe(true);
      expect(requiresShell('script.BAT')).toBe(true);
      expect(requiresShell('script.PS1')).toBe(true);
    });
  });

  describe('joinPaths', () => {
    it('joins paths with platform separator', () => {
      const result = joinPaths('home', 'user', 'project');
      expect(result).toContain('project');
    });
  });

});
