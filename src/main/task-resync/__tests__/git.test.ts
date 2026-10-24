/**
 * The merge checks (real git repos): the resync's `verifyResync` and the merge helper's
 * `mergeTargetIntoBranch` follow renames, read diffs the same whatever the user's git config says,
 * and see added lines that start with `++`
 */
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));

import { verifyResync } from '../git';
import { mergeTargetIntoBranch } from '../../ai/runners/merge-target-into-branch';
import type { MergeAgentFn } from '../../ai/runners/merge-agent';

const BASE = ['export function greet(name: string) {', '  const greeting = "Hello";', '  return `${greeting}, ${name}`;', '}', '', 'export const VERSION = 1;', ''].join('\n');
const FROM_MAIN = BASE.replace('"Hello"', '"Good day"').replace('export const VERSION = 1;', 'export const VERSION = 2;\nexport function fromMain() { return "added by main"; }');

let tmp: string;
let root: string;
let wt: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd: string, ...args: string[]) => {
  try { git(cwd, ...args); } catch { /* conflicts */ }
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'resync-git-'));
  root = path.join(tmp, 'project');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'a.ts'), BASE);
  git(root, 'add', 'a.ts');
  git(root, 'commit', '-q', '-m', 'base');
  wt = path.join(tmp, 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'workbench/002-b', wt, 'main');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** The task (renames a.ts to b.ts and) changes the greeting; main changes it too and adds a function */
function diverge(rename: boolean): void {
  if (rename) git(wt, 'mv', 'a.ts', 'b.ts');
  writeFileSync(path.join(wt, rename ? 'b.ts' : 'a.ts'), BASE.replace('"Hello"', '"Hi there"'));
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'task work');
  writeFileSync(path.join(root, 'a.ts'), FROM_MAIN);
  git(root, 'commit', '-q', '-am', 'task a merged into main');
}

/** The session merges main and resolves every conflict keeping its own side (main's lines lost) */
function mergeKeepingOurs(): void {
  tryGit(wt, 'merge', '--no-edit', 'main');
  for (const file of git(wt, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) {
    git(wt, 'checkout', '--ours', '--', file);
    git(wt, 'add', '--', file);
  }
  git(wt, 'commit', '-q', '--no-edit');
}

describe('verifyResync', () => {
  it('finds lines lost in a file the task renamed and the base branch changed', async () => {
    diverge(true);
    const targetCommit = git(wt, 'rev-parse', 'main');
    mergeKeepingOurs();

    const check = await verifyResync(wt, { targetCommit, name: 'main' });

    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([{ file: 'b.ts', lines: expect.arrayContaining(['export function fromMain() { return "added by main"; }']) }]);
  });

  it("finds lines lost in a file the base branch renamed and the task changed", async () => {
    writeFileSync(path.join(wt, 'a.ts'), BASE.replace('"Hello"', '"Hi there"'));
    git(wt, 'commit', '-q', '-am', 'task work');
    git(root, 'mv', 'a.ts', 'c.ts');
    writeFileSync(path.join(root, 'c.ts'), BASE.replace('export const VERSION = 1;', 'export const VERSION = 1;\nexport const FROM_MAIN = true;'));
    git(root, 'commit', '-q', '-am', 'main renames a.ts');
    const targetCommit = git(wt, 'rev-parse', 'main');
    git(wt, 'merge', '--no-edit', 'main');
    // The session loses main's new line while keeping its own change
    writeFileSync(path.join(wt, 'c.ts'), BASE.replace('"Hello"', '"Hi there"'));
    git(wt, 'commit', '-q', '-am', 'tidy');

    const check = await verifyResync(wt, { targetCommit, name: 'main' });

    expect(check.missing).toEqual([{ file: 'c.ts', lines: ['export const FROM_MAIN = true;'] }]);
  });

  it('reads diffs the same with color, an external diff tool and textconv in the git config', async () => {
    diverge(false);
    const targetCommit = git(wt, 'rev-parse', 'main');
    mergeKeepingOurs();
    const tool = path.join(tmp, 'ext-diff.sh');
    writeFileSync(tool, '#!/bin/sh\necho "external diff"\n');
    chmodSync(tool, 0o755);
    git(root, 'config', 'color.ui', 'always');
    git(root, 'config', 'diff.external', tool);
    git(root, 'config', 'diff.ts.textconv', 'cat /dev/null;');
    writeFileSync(path.join(root, '.git', 'info', 'attributes'), '*.ts diff=ts\n');

    const check = await verifyResync(wt, { targetCommit, name: 'main' });

    expect(check.missing).toEqual([{ file: 'a.ts', lines: expect.arrayContaining(['export function fromMain() { return "added by main"; }']) }]);
  });

  it('sees an added line that starts with ++', async () => {
    writeFileSync(path.join(wt, 'a.ts'), BASE.replace('"Hello"', '"Hi there"'));
    git(wt, 'commit', '-q', '-am', 'task work');
    writeFileSync(path.join(root, 'a.ts'), BASE.replace('"Hello"', '"Good day"').replace('export const VERSION = 1;', 'export const VERSION = 1;\n++counter;'));
    git(root, 'commit', '-q', '-am', 'main');
    const targetCommit = git(wt, 'rev-parse', 'main');
    mergeKeepingOurs();

    const check = await verifyResync(wt, { targetCommit, name: 'main' });

    expect(check.missing).toEqual([{ file: 'a.ts', lines: expect.arrayContaining(['++counter;']) }]);
  });
});

describe('mergeTargetIntoBranch', () => {
  it('checks the lines of a conflicted file the task renamed against what the base branch added', async () => {
    diverge(true);
    const calls: Array<{ conflictedFiles: string[]; missing?: unknown }> = [];
    const mergeAgent: MergeAgentFn = async (input) => {
      calls.push({ conflictedFiles: input.conflictedFiles, missing: input.missingLines });
      for (const file of input.conflictedFiles) {
        if (!input.missingLines) git(wt, 'checkout', '--ours', '--', file);
        git(wt, 'add', '--', file);
      }
      if (!input.missingLines) git(wt, 'commit', '-q', '--no-edit');
      return { status: 'resolved', summary: 'kept ours', intentionallyDropped: [] };
    };

    const result = await mergeTargetIntoBranch({ worktreePath: wt, branch: 'workbench/002-b', targetRef: 'main', targetName: 'main', mergeAgent });

    expect(result.success).toBe(false);
    expect(result.error).toContain('The merge would lose changes from main (b.ts:');
    expect(calls[1]?.missing).toEqual([{ file: 'b.ts', lines: expect.arrayContaining(['export function fromMain() { return "added by main"; }']) }]);
  });
});
