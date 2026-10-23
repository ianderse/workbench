/**
 * Merging a task's pull request (real git repos, fake gh and merge agent):
 * - the target branch is pulled into the task branch first, then the branch is pushed and the
 *   PR merged
 * - conflicts go to the merge agent; a resolution that loses lines the target added gets a
 *   second pass, and a failed one leaves the worktree as it was
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));
vi.mock('../merge-agent', () => ({ runMergeAgent: vi.fn() }));

import { mergePR, type MergePRConfig } from '../github/pr-merger';
import type { MergeAgentFn, MergeAgentInput } from '../merge-agent';

const PR_URL = 'https://github.com/example/repo/pull/7';
const BRANCH = 'workbench/001-a';

let tmp: string;
let seed: string;
let worktree: string;
let project: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const configure = (repo: string) => {
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
};
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pr-merger-'));
  const origin = path.join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);

  // Another clone stands for the tasks that merge into main meanwhile
  seed = path.join(tmp, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  configure(seed);
  commitFile(seed, 'a.txt', 'one\ntwo\nthree\n', 'base');
  commitFile(seed, 'b.txt', 'b\n', 'base b');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');

  project = path.join(tmp, 'project');
  git(tmp, 'clone', '-q', origin, project);
  configure(project);
  worktree = path.join(tmp, 'wt');
  git(project, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'origin/main');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** gh that knows one open PR (base `main` unless given) and records its calls */
function fakeGh(view: { state?: string; baseRefName?: string } = {}) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ state: view.state ?? 'OPEN', baseRefName: view.baseRefName ?? 'main', headRefName: BRANCH });
    }
    return '';
  };
  return { gh, calls };
}

function config(overrides: Partial<MergePRConfig>): MergePRConfig {
  return { projectDir: project, worktreePath: worktree, prUrl: PR_URL, ...overrides };
}

const pushedBranchHas = (ref: string) => {
  git(project, 'fetch', '-q', 'origin');
  try {
    git(project, 'merge-base', '--is-ancestor', ref, `origin/${BRANCH}`);
    return true;
  } catch {
    return false;
  }
};

describe('mergePR', () => {
  it('pulls the target into the task branch, pushes it and merges the PR (moving it to the chosen branch)', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo\nthree\ntask\n', 'task change');
    commitFile(seed, 'b.txt', 'b\nfrom another task\n', 'other task');
    git(seed, 'push', '-q', 'origin', 'main');
    const { gh, calls } = fakeGh({ baseRefName: 'release' });
    const mergeAgent = vi.fn<MergeAgentFn>();
    const steps: string[] = [];

    const result = await mergePR(config({ gh, mergeAgent, targetBranch: 'main', onProgress: (step) => steps.push(step) }));

    expect(result).toMatchObject({ success: true, targetBranch: 'main', conflictedFiles: [] });
    expect(mergeAgent).not.toHaveBeenCalled();
    expect(readFileSync(path.join(worktree, 'b.txt'), 'utf-8')).toBe('b\nfrom another task\n');
    expect(pushedBranchHas('origin/main')).toBe(true);
    expect(calls).toContainEqual(['pr', 'edit', PR_URL, '--base', 'main']);
    expect(calls.at(-1)).toEqual(['pr', 'merge', PR_URL, '--merge']);
    expect(steps).toEqual(['checking', 'pulling', 'pushing', 'merging']);
  });

  it('has the merge agent resolve conflicts, keeping both sides', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo task\nthree\n', 'task change');
    commitFile(seed, 'a.txt', 'one\ntwo other\nthree\n', 'other task');
    git(seed, 'push', '-q', 'origin', 'main');
    const { gh, calls } = fakeGh();
    const mergeAgent = vi.fn<MergeAgentFn>(async (input: MergeAgentInput) => {
      expect(input).toMatchObject({ conflictedFiles: ['a.txt'], targetRef: 'origin/main', branch: BRANCH });
      writeFileSync(path.join(worktree, 'a.txt'), 'one\ntwo task\ntwo other\nthree\n');
      git(worktree, 'add', 'a.txt');
      git(worktree, 'commit', '-q', '--no-edit');
      return { status: 'resolved', summary: 'Kept both lines', intentionallyDropped: [] };
    });

    const result = await mergePR(config({ gh, mergeAgent }));

    expect(result).toMatchObject({ success: true, conflictedFiles: ['a.txt'], summary: 'Kept both lines' });
    expect(mergeAgent).toHaveBeenCalledTimes(1);
    expect(pushedBranchHas('origin/main')).toBe(true);
    expect(calls.at(-1)).toEqual(['pr', 'merge', PR_URL, '--merge']);
  });

  it('gives the merge agent a second pass for target lines its resolution lost', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo task\nthree\n', 'task change');
    commitFile(seed, 'a.txt', 'one\ntwo other\nthree\n', 'other task');
    git(seed, 'push', '-q', 'origin', 'main');
    const { gh } = fakeGh();
    const inputs: MergeAgentInput[] = [];
    const mergeAgent = vi.fn<MergeAgentFn>(async (input: MergeAgentInput) => {
      inputs.push(input);
      if (!input.missingLines) {
        // Takes this task's side only: the other task's line is lost
        writeFileSync(path.join(worktree, 'a.txt'), 'one\ntwo task\nthree\n');
        git(worktree, 'add', 'a.txt');
        git(worktree, 'commit', '-q', '--no-edit');
      } else {
        writeFileSync(path.join(worktree, 'a.txt'), 'one\ntwo task\ntwo other\nthree\n');
      }
      return { status: 'resolved', summary: input.missingLines ? 'Restored' : 'Resolved', intentionallyDropped: [] };
    });

    const result = await mergePR(config({ gh, mergeAgent }));

    expect(result.success).toBe(true);
    expect(inputs[1].missingLines).toEqual([{ file: 'a.txt', lines: ['two other'] }]);
    expect(git(worktree, 'show', 'HEAD:a.txt')).toBe('one\ntwo task\ntwo other\nthree');
    expect(pushedBranchHas('origin/main')).toBe(true);
  });

  it('refuses to merge when the target lines stay lost, and leaves the worktree as it was', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo task\nthree\n', 'task change');
    commitFile(seed, 'a.txt', 'one\ntwo other\nthree\n', 'other task');
    git(seed, 'push', '-q', 'origin', 'main');
    const before = git(worktree, 'rev-parse', 'HEAD');
    const { gh, calls } = fakeGh();
    const mergeAgent = vi.fn<MergeAgentFn>(async (input: MergeAgentInput) => {
      if (!input.missingLines) {
        writeFileSync(path.join(worktree, 'a.txt'), 'one\ntwo task\nthree\n');
        git(worktree, 'add', 'a.txt');
        git(worktree, 'commit', '-q', '--no-edit');
      }
      return { status: 'resolved', summary: 'Done', intentionallyDropped: [] };
    });

    const result = await mergePR(config({ gh, mergeAgent }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('would lose changes from main');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(calls.some((args) => args[1] === 'merge')).toBe(false);
  });

  it('accepts a target line the agent dropped on purpose, with its reason', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo task\nthree\n', 'task change');
    commitFile(seed, 'a.txt', 'one\ntwo other\nthree\n', 'other task');
    git(seed, 'push', '-q', 'origin', 'main');
    const { gh } = fakeGh();
    const mergeAgent = vi.fn<MergeAgentFn>(async (input: MergeAgentInput) => {
      if (!input.missingLines) {
        writeFileSync(path.join(worktree, 'a.txt'), 'one\ntwo task\nthree\n');
        git(worktree, 'add', 'a.txt');
        git(worktree, 'commit', '-q', '--no-edit');
        return { status: 'resolved', summary: 'Resolved', intentionallyDropped: [] };
      }
      return { status: 'resolved', summary: 'Kept', intentionallyDropped: [{ file: 'a.txt', line: 'two other', reason: 'The task replaces it' }] };
    });

    expect((await mergePR(config({ gh, mergeAgent }))).success).toBe(true);
  });

  it('aborts the merge when the agent cannot resolve it', async () => {
    commitFile(worktree, 'a.txt', 'one\ntwo task\nthree\n', 'task change');
    commitFile(seed, 'a.txt', 'one\ntwo other\nthree\n', 'other task');
    git(seed, 'push', '-q', 'origin', 'main');
    const before = git(worktree, 'rev-parse', 'HEAD');
    const { gh, calls } = fakeGh();
    const mergeAgent = vi.fn<MergeAgentFn>(async () => ({ status: 'failed', summary: 'Too risky', intentionallyDropped: [] }));

    const result = await mergePR(config({ gh, mergeAgent }));

    expect(result).toMatchObject({ success: false, conflictedFiles: ['a.txt'] });
    expect(result.error).toContain('Too risky');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(path.join(worktree, '.git'))).toBe(true);
    expect(() => git(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(worktree, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(calls.some((args) => args[1] === 'merge')).toBe(false);
  });

  it('reports an already merged PR without touching the worktree', async () => {
    const { gh, calls } = fakeGh({ state: 'MERGED' });
    const result = await mergePR(config({ gh, mergeAgent: vi.fn<MergeAgentFn>() }));
    expect(result).toMatchObject({ success: true, alreadyMerged: true, targetBranch: 'main' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a worktree with uncommitted changes', async () => {
    writeFileSync(path.join(worktree, 'a.txt'), 'edited\n');
    const { gh, calls } = fakeGh();
    const result = await mergePR(config({ gh, mergeAgent: vi.fn<MergeAgentFn>() }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('uncommitted changes');
    expect(calls).toHaveLength(1);
  });
});
