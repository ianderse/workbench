/**
 * git() (utils/git-exec) runs the real git through the runtime layer:
 * - resolves with { stdout, stderr } and rejects with git's exit code and output
 * - `isolated` drops leaked worktree variables (GIT_DIR & co.) and sets HUSKY=0, from the
 *   caller's environment when one is given
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({ getToolPathAsync: async () => 'git' }));

import { git } from '../git-exec';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'git-exec-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('git', () => {
  it('runs git in the given directory and returns its output', async () => {
    await git(['init', '-q', '-b', 'main'], { cwd: repo });
    const { stdout, stderr } = await git(['rev-parse', '--is-inside-work-tree'], { cwd: repo, encoding: 'utf-8' });
    expect(stdout.trim()).toBe('true');
    expect(stderr).toBe('');
  });

  it("rejects with git's exit code and error output", async () => {
    await expect(git(['rev-parse', '--verify', 'no-such-branch'], { cwd: repo })).rejects.toMatchObject({
      code: 128,
      stderr: expect.stringContaining('not a git repository'),
    });
  });

  it('isolated: ignores a leaked GIT_DIR and turns husky off', async () => {
    await git(['init', '-q', '-b', 'main'], { cwd: repo });
    const env = { ...process.env, GIT_DIR: path.join(repo, 'elsewhere', '.git'), HUSKY: '1' };

    await expect(git(['rev-parse', '--git-dir'], { cwd: repo, env })).rejects.toBeTruthy();

    const { stdout } = await git(['rev-parse', '--git-dir'], { cwd: repo, env, isolated: true });
    expect(stdout.trim()).toBe('.git');
    // A shell alias prints the environment git runs with
    const { stdout: husky } = await git(['-c', 'alias.husky=!printf %s "$HUSKY"', 'husky'], { cwd: repo, env, isolated: true });
    expect(husky).toBe('0');
  });
});
