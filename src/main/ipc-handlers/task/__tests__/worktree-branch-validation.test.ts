/**
 * Tests for worktree branch validation logic.
 *
 * Issue #1479: When cleaning up a corrupted worktree, git rev-parse walks up
 * to the main project and returns its current branch instead of the worktree's branch.
 * This could cause deletion of the wrong branch.
 *
 * These tests verify the validation logic that prevents this.
 */

import { describe, expect, it, vi } from 'vitest';
import { GIT_BRANCH_REGEX } from '../worktree-handlers';

// The handlers load the project store, whose logger needs the Electron binary
vi.mock('../../../app-logger', () => ({ appLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe('GIT_BRANCH_REGEX', () => {
  it('should accept valid workbench branch names', () => {
    expect(GIT_BRANCH_REGEX.test('workbench/my-feature')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('workbench/123-fix-bug')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('workbench/feature_with_underscore')).toBe(true);
  });

  it('should accept valid feature branch names', () => {
    expect(GIT_BRANCH_REGEX.test('feature/my-feature')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('fix/bug-123')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('main')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('develop')).toBe(true);
  });

  it('should accept single character branch names', () => {
    expect(GIT_BRANCH_REGEX.test('a')).toBe(true);
    expect(GIT_BRANCH_REGEX.test('1')).toBe(true);
  });

  it('should reject invalid branch names', () => {
    expect(GIT_BRANCH_REGEX.test('')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('-invalid')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('invalid-')).toBe(false);
    expect(GIT_BRANCH_REGEX.test('.invalid')).toBe(false);
  });

  it('should accept HEAD as syntactically valid (handled specially in validation logic)', () => {
    // HEAD is technically valid as a git branch name syntactically,
    // but when detected from rev-parse it indicates detached state.
    // The validateWorktreeBranch function handles this case specially.
    expect(GIT_BRANCH_REGEX.test('HEAD')).toBe(true);
  });
});

