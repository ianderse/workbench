/**
 * Backup of a task's work before its worktree is thrown away
 * ===========================================================
 *
 * Starting a task over (and discarding its worktree) deletes the worktree folder and the task
 * branch: commits and uncommitted changes alike. Before that happens, everything the task made
 * is saved on a branch `workbench/backup/<spec-id>-<yyyyMMdd-HHmmss>` in the project's own
 * repository, so the user can always get it back.
 *
 * The work is committed on the task branch inside the task's worktree (never in the user's main
 * checkout) and the backup branch is created at that commit. Generated folders (node_modules, ...)
 * are left out through `stageTaskWork`. If any step fails the caller must not discard anything.
 */

import { existsSync } from 'fs';
import { git } from './git-exec';
import { stageTaskWork } from '../claude-code/stage-excludes';
import { findTaskWorktree } from '../worktree-paths';

export interface TaskWorkBackupResult {
  /** `saved`: the work is on `branch`; `nothing`: there was no work to keep; `failed`: not saved, do not discard */
  status: 'saved' | 'nothing' | 'failed';
  branch?: string;
  error?: string;
}

const GIT_TIMEOUT = 60000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `yyyyMMdd-HHmmss` in local time */
export function backupTimestamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function backupBranchName(specId: string, date = new Date()): string {
  return `workbench/backup/${specId}-${backupTimestamp(date)}`;
}

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await git(args, { cwd, isolated: true, timeout: GIT_TIMEOUT, encoding: 'utf-8' });
  return String(stdout);
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], projectPath);
    return true;
  } catch {
    return false;
  }
}

/** Whether `ref` has commits that no other branch (local or remote) has */
async function hasUniqueCommits(cwd: string, ref: string, taskBranch: string): Promise<boolean> {
  const out = await gitOut(
    ['rev-list', '-n', '1', ref, '--not', `--exclude=${taskBranch}`, '--branches', '--remotes'],
    cwd
  );
  return out.trim().length > 0;
}

/**
 * Save a task's work (commits not on any other branch, uncommitted and untracked changes) on a
 * new backup branch. Returns `nothing` when the task has no worktree or branch with work in it.
 */
export async function backupTaskWork(projectPath: string, specId: string): Promise<TaskWorkBackupResult> {
  const taskBranch = `workbench/${specId}`;
  try {
    const found = findTaskWorktree(projectPath, specId);
    const worktreePath = found && existsSync(found) ? found : null;
    let target: string | null = null;

    if (worktreePath) {
      // Tracked changes plus new files, minus generated folders; committed on the task branch
      const staged = await stageTaskWork(worktreePath, ['.workbench'], { isolated: true, timeout: GIT_TIMEOUT });
      if (staged) {
        const identity: string[] = [];
        const email = (await gitOut(['config', 'user.email'], worktreePath).catch(() => '')).trim();
        if (!email) identity.push('-c', 'user.name=Workbench', '-c', 'user.email=workbench@localhost');
        await git(
          [...identity, 'commit', '--no-verify', '-m', `Backup of ${specId} before it was discarded`],
          { cwd: worktreePath, isolated: true, timeout: GIT_TIMEOUT }
        );
      }
      if (await hasUniqueCommits(worktreePath, 'HEAD', taskBranch)) target = 'HEAD';
    } else if (await branchExists(projectPath, taskBranch)) {
      // The folder is gone (deleted by hand) but the branch still carries the commits
      if (await hasUniqueCommits(projectPath, `refs/heads/${taskBranch}`, taskBranch)) {
        target = `refs/heads/${taskBranch}`;
      }
    }

    if (!target) return { status: 'nothing' };

    const base = backupBranchName(specId);
    let branch = base;
    for (let i = 2; await branchExists(projectPath, branch); i++) {
      branch = `${base}-${i}`;
    }
    await gitOut(['branch', branch, target], worktreePath ?? projectPath);
    // The branch must resolve before anything is deleted
    await gitOut(['rev-parse', '--verify', `refs/heads/${branch}`], projectPath);
    return { status: 'saved', branch };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
