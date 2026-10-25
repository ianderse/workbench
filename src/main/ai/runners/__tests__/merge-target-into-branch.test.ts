/**
 * The shared "bring the target into the task branch" helper (real git repos, fake merge agent):
 * - a conflict is resolved by the agent and committed
 * - an agent that cannot resolve it leaves the worktree exactly as it was
 * - a resolution that loses lines the target added is refused (after a second pass)
 * - the task's own backend reaches the agent and the backend layer (`runClaudeText`)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));
const mockRunClaudeText = vi.fn();
vi.mock('../../../claude-code/run-text', () => ({ runClaudeText: (...args: unknown[]) => mockRunClaudeText(...args) }));

import { mergeTargetIntoBranch } from '../merge-target-into-branch';
import { runMergeAgent, type MergeAgentFn } from '../merge-agent';

let tmp: string;
let project: string;
let worktree: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};
const resolved = (content: string): MergeAgentFn => vi.fn(async (input) => {
  writeFileSync(path.join(input.worktreePath, 'a.txt'), content);
  git(input.worktreePath, 'add', 'a.txt');
  return { status: 'resolved' as const, summary: 'ok', intentionallyDropped: [] };
});
const merge = (mergeAgent: MergeAgentFn, extra: Partial<Parameters<typeof mergeTargetIntoBranch>[0]> = {}) =>
  mergeTargetIntoBranch({ worktreePath: worktree, branch: 'workbench/002-b', targetRef: 'main', targetName: 'main', mergeAgent, ...extra });

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'merge-target-'));
  project = path.join(tmp, 'project');
  git(tmp, 'init', '-q', '-b', 'main', project);
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'commit.gpgsign', 'false');
  git(project, 'config', 'core.autocrlf', 'false');
  commitFile(project, 'a.txt', 'one\ntwo\nthree\n', 'base');
  worktree = path.join(tmp, 'wt');
  git(project, 'worktree', 'add', '-q', '-b', 'workbench/002-b', worktree, 'main');
  commitFile(worktree, 'a.txt', 'one\nTWO from task\nthree\n', 'task');
  // Another task merged into main meanwhile
  commitFile(project, 'a.txt', 'one\nTWO from main\nthree\nmain extra line\n', 'main moves');
  mockRunClaudeText.mockReset();
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('mergeTargetIntoBranch', () => {
  it('merges without the agent when there is no conflict', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo\nthree\n', 'undo');
    git(worktree, 'reset', '-q', '--hard', 'main');
    commitFile(worktree, 'b.txt', 'b\n', 'task b');
    const agent = vi.fn();
    const result = await merge(agent as unknown as MergeAgentFn);
    expect(result).toMatchObject({ success: true, conflictedFiles: [] });
    expect(agent).not.toHaveBeenCalled();
    expect(git(worktree, 'merge-base', '--is-ancestor', 'main', 'HEAD') ?? '').toBe('');
  });

  it('has the agent resolve a conflict and commits the merge', async () => {
    const agent = resolved('one\nTWO from task\nTWO from main\nthree\nmain extra line\n');
    const result = await merge(agent);
    expect(result).toMatchObject({ success: true, conflictedFiles: ['a.txt'] });
    expect(agent).toHaveBeenCalledTimes(1);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(readFileSync(path.join(worktree, 'a.txt'), 'utf-8')).toContain('TWO from main');
  });

  it('aborts and leaves the worktree clean when the agent cannot resolve it', async () => {
    const before = git(worktree, 'rev-parse', 'HEAD');
    const agent: MergeAgentFn = vi.fn(async () => ({ status: 'failed' as const, summary: 'cannot', intentionallyDropped: [] }));
    const result = await merge(agent);
    expect(result.success).toBe(false);
    expect(result.conflictedFiles).toEqual(['a.txt']);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(() => git(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
  });

  it('refuses a resolution that loses a line the target added, and rolls back', async () => {
    const before = git(worktree, 'rev-parse', 'HEAD');
    // Resolves, drops "main extra line"; the second pass does not bring it back either
    const agent = resolved('one\nTWO from task\nthree\n');
    const result = await merge(agent);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/lose changes from main/);
    expect(agent).toHaveBeenCalledTimes(2);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
  });

  it('hands the task backend to the merge agent', async () => {
    const agent = resolved('one\nTWO from task\nTWO from main\nthree\nmain extra line\n');
    await merge(agent, { backend: 'omp' });
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ backend: 'omp' }));
  });
});

describe('runMergeAgent', () => {
  const input = { worktreePath: '/tmp/wt', branch: 'b', targetRef: 'main', conflictedFiles: ['a.txt'] };
  beforeEach(() => mockRunClaudeText.mockResolvedValue({ text: '', structured: { status: 'resolved', summary: 's', intentionallyDropped: [] } }));

  it('runs through runClaudeText with the task backend (a pin to OMP or Claude Code)', async () => {
    await runMergeAgent({ ...input, backend: 'omp' });
    expect(mockRunClaudeText).toHaveBeenCalledWith(expect.objectContaining({ backend: 'omp', usage: { job: 'merge' } }));
    await runMergeAgent({ ...input, backend: 'claude' });
    expect(mockRunClaudeText).toHaveBeenLastCalledWith(expect.objectContaining({ backend: 'claude' }));
  });

  it('leaves the backend to the app setting when the task has none', async () => {
    await runMergeAgent(input);
    expect(mockRunClaudeText.mock.calls[0][0].backend).toBeUndefined();
  });
});
