/**
 * Worktree Manager
 * ================
 *
 * TypeScript replacement for the Python WorktreeManager.create_worktree()
 * See src/main/ai/worktree/worktree-manager.ts for the TypeScript implementation.
 *
 * Creates and manages git worktrees for autonomous task execution.
 * Each task runs in an isolated worktree at:
 *   {projectPath}/.workbench/worktrees/tasks/{specId}/
 * on branch:
 *   workbench/{specId}
 *
 * The function is idempotent — calling it repeatedly with the same specId
 * returns the existing worktree without error.
 */

import { existsSync, mkdirSync } from 'fs';
import { cp, rm } from 'fs/promises';
import { join, resolve } from 'path';

import { getSpecsDir } from '../../shared/constants';
import { isSelfImproveEnabledForPath } from '../self-improve/setting';
import { baseBranchRefCandidates, fetchBaseBranch, lookUpBaseBranchRef } from '../utils/base-branch';
import { git as runGit } from '../utils/git-exec';
import { toHostPath } from '../platform/shell-runtime';
import { pruneWorktrees, repairForeignWorktrees, worktreeGitArgs, worktreePathKey } from './runtime-worktrees';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a git sub-command in the given working directory.
 * Returns stdout on success, throws on non-zero exit (unless `allowFailure` is
 * set to true, in which case an empty string is returned instead of throwing).
 */
async function git(
  args: string[],
  cwd: string,
  allowFailure = false,
): Promise<string> {
  try {
    const { stdout } = await runGit(args, { cwd });
    return stdout.trim();
  } catch (err: unknown) {
    if (allowFailure) {
      return '';
    }
    const message = err instanceof Error ? err.message : String(err);
    // The sub-command, after any `-c <config>` options
    const command = args.find((arg, i) => arg !== '-c' && args[i - 1] !== '-c') ?? args[0];
    throw new Error(`git ${command} failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorktreeResult {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Git branch name checked out in the worktree */
  branch: string;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Create or return an existing git worktree for the given spec.
 *
 * Mirrors WorktreeManager.create_worktree() from the Python backend.
 *
 * @param projectPath    Absolute path to the project root (git repo)
 * @param specId         Spec folder name, e.g. "001-my-feature"
 * @param baseBranch     Base branch to branch from (defaults to "main")
 * @param useLocalBranch If true, always use the local base branch instead of
 *                       the remote ref (preserves gitignored files)
 * @param pushNewBranches If true, push the branch to origin and set upstream
 *                        tracking after worktree creation. Defaults to true.
 * @param autoBuildPath  Optional custom data directory (e.g. ".workbench").
 *                       Passed to getSpecsDir() for spec-copy logic.
 */
export async function createOrGetWorktree(
  projectPath: string,
  specId: string,
  baseBranch = 'main',
  useLocalBranch = false,
  pushNewBranches = true,
  autoBuildPath?: string,
): Promise<WorktreeResult> {
  const worktreePath = join(projectPath, '.workbench/worktrees/tasks', specId);
  const branchName = `workbench/${specId}`;

  // ------------------------------------------------------------------
  // Step 1: Prune stale worktree references from git's internal records
  // ------------------------------------------------------------------
  // On Windows, worktrees linked by the other runtime's git (native / WSL) are repaired first, or
  // the prune would drop them as broken. `pruneWorktrees` then only removes registrations whose
  // folders are really gone: that is what lets a worktree deleted outside the app stop blocking its
  // task, while a worktree still on disk is never unregistered - step 3 below deletes the folder
  // git no longer tracks, so an over-eager prune here would take uncommitted work with it.
  await repairForeignWorktrees(projectPath);
  console.warn('[WorktreeManager] Pruning stale worktree references...');
  await pruneWorktrees(projectPath);

  // ------------------------------------------------------------------
  // Step 2: Return early when worktree already exists and is registered
  // ------------------------------------------------------------------
  if (existsSync(worktreePath)) {
    const isRegistered = await isWorktreeRegistered(worktreePath, projectPath);

    if (isRegistered) {
      console.warn(
        `[WorktreeManager] Using existing worktree: ${specId} on branch ${branchName}`,
      );
      return { worktreePath: resolve(worktreePath), branch: branchName };
    }

    // ------------------------------------------------------------------
    // Step 3: Remove stale directory that git no longer tracks
    // ------------------------------------------------------------------
    console.warn(
      `[WorktreeManager] Removing stale worktree directory: ${specId}`,
    );
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[WorktreeManager] Failed to remove stale worktree directory at ${worktreePath}: ${message}`,
      );
    }

    if (existsSync(worktreePath)) {
      throw new Error(
        `[WorktreeManager] Stale worktree directory still exists after removal: ${worktreePath}. ` +
          'This may be due to permission issues or file locks.',
      );
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Check whether the target branch already exists locally
  // ------------------------------------------------------------------
  const branchListOutput = await git(
    ['branch', '--list', branchName],
    projectPath,
    /* allowFailure */ true,
  );
  const branchExists = branchListOutput.includes(branchName);

  // The ref the base branch resolves to, through the same lookup that validated it
  // (utils/base-branch), which is what keeps the two from disagreeing: a branch that only exists
  // on a remote other than origin was accepted there, so it has to be a branch this step can both
  // refresh and cut a worktree from. `useLocalBranch` decides whether the local branch or the
  // remote ref wins when both exist - the local one preserves files a fetched ref knows nothing
  // about. The lookup fetches by itself when the repo has not got the ref it wants, and reports
  // whether it did: that is a branch a teammate pushed since the last fetch, and equally a
  // `useLocalBranch` false start in a repo that has the branch only locally (never fetched, a
  // single-branch clone, a remote added later), where answering from the refs on disk would turn
  // the remote-first default into a start from the user's own possibly stale local branch.
  // Whichever it is, it is one fetch, and step 5 then skips the fetch it would otherwise run.
  const base = branchExists
    ? null
    : await lookUpBaseBranchRef(projectPath, baseBranch, { preferLocal: useLocalBranch });
  const startPoint = base?.ref ?? null;

  // ------------------------------------------------------------------
  // Step 5: Fetch latest from remote (non-fatal — remote may not exist)
  // ------------------------------------------------------------------
  // The remote AND the name on it both come from the resolved ref, because the base branch may
  // live on a fork or a second upstream and may carry that remote in its own name: asking origin
  // for `upstream/main` is a refspec no remote has, and since the fetch is best-effort the
  // rejection would pass unnoticed and leave the worktree on whatever the last working fetch
  // brought in - stale code the agent then implements on. There is nothing to refresh when the
  // task's branch already exists (the worktree attaches to it, not to the base branch) or when
  // the start point is a local branch, and nothing to repeat when the lookup just fetched it.
  if (base?.fetch && !base.fetched) {
    console.warn(
      `[WorktreeManager] Fetching latest from ${base.fetch.remote}/${base.fetch.branch}...`,
    );
    await fetchBaseBranch(projectPath, base.fetch);
  }

  // ------------------------------------------------------------------
  // Step 6: Create the worktree
  // ------------------------------------------------------------------
  if (branchExists) {
    // Branch already exists — attach the worktree to it without -b
    console.warn(`[WorktreeManager] Reusing existing branch: ${branchName}`);
    await git(
      await worktreeGitArgs(['worktree', 'add', worktreePath, branchName]),
      projectPath,
    );
  } else {
    if (!startPoint) {
      // Naming the refs that were tried, rather than a fixed pair, is what tells the user whether
      // the branch was looked for on the remote they expected
      const tried = await baseBranchRefCandidates(projectPath, baseBranch, { preferLocal: useLocalBranch });
      // Saying that the remote was asked as well stops the user from reading this as a repo that
      // simply needs fetching, when the fetch is exactly what has already come back empty
      const fetched = base?.fetched ? ' A fetch of the remote did not bring it in either.' : '';
      throw new Error(
        `Base branch "${baseBranch}" does not exist in this repository (looked for ${tried.join(', ')}).${fetched} ` +
          'Create it, or give the task a base branch that exists.',
      );
    }

    console.warn(`[WorktreeManager] Creating worktree from ${startPoint}`);

    // Relative links (git 2.48+) when every git that may open the repository supports them
    await git(
      await worktreeGitArgs(['worktree', 'add', '-b', branchName, '--no-track', worktreePath, startPoint]),
      projectPath,
    );
  }

  console.warn(
    `[WorktreeManager] Created worktree: ${specId} on branch ${branchName}`,
  );

  // Best-effort upstream setup: the remote branch does not exist until first push,
  // so publish it here when origin is available instead of inheriting origin/main.
  if (pushNewBranches) {
    const hasOrigin = await git(
      ['remote', 'get-url', 'origin'],
      projectPath,
      /* allowFailure */ true,
    );

    if (hasOrigin) {
      try {
        await git(
          ['push', '--set-upstream', 'origin', branchName],
          worktreePath,
        );
        console.warn(
          `[WorktreeManager] Pushed and set upstream: origin/${branchName}`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[WorktreeManager] Warning: Could not push upstream for ${branchName}: ${message}`,
        );
      }
    }
  } else {
    console.warn(
      `[WorktreeManager] Leaving branch local-only (auto-push disabled): ${branchName}`,
    );
  }

  // ------------------------------------------------------------------
  // Step 7: Copy spec directory into the worktree
  //
  // .workbench/tasks/ is gitignored, so it is NOT present in the
  // newly-created worktree checkout. Copy it from the main project so
  // that agents can read spec.md, implementation_plan.json, etc.
  // ------------------------------------------------------------------
  const specsRelDir = getSpecsDir(autoBuildPath); // e.g. ".workbench/tasks"
  const sourceSpecDir = join(projectPath, specsRelDir, specId);
  const destSpecDir = join(worktreePath, specsRelDir, specId);

  if (existsSync(sourceSpecDir) && !existsSync(destSpecDir)) {
    console.warn(
      `[WorktreeManager] Copying spec directory into worktree: ${specsRelDir}/${specId}`,
    );

    // Ensure parent dirs exist inside the worktree
    const destParent = join(worktreePath, specsRelDir);
    mkdirSync(destParent, { recursive: true });

    try {
      await cp(sourceSpecDir, destSpecDir, { recursive: true });
    } catch (err: unknown) {
      // Non-fatal: log and continue. The spec may already be present via
      // a symlink or the agent can regenerate it.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[WorktreeManager] Warning: Could not copy spec directory to worktree: ${message}`,
      );
    }
  }

  // A worktree is its own checkout and .claude/settings.local.json isn't committed, so a session
  // started here would otherwise fall back to ~/.claude and split the project's memory in two
  if (await isSelfImproveEnabledForPath(projectPath)) {
    // Imported here rather than at the top: this is the only use, and the module behind it reaches
    // the app logger, which pulls electron into everything that imports worktree creation
    const { ensureWorktreeProjectMemory } = await import('../self-improve/relocation');
    await ensureWorktreeProjectMemory(resolve(worktreePath), projectPath);
  }

  return { worktreePath: resolve(worktreePath), branch: branchName };
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

/**
 * Returns true when the given path appears in `git worktree list --porcelain`
 * output, meaning git knows about this worktree.
 */
async function isWorktreeRegistered(
  worktreePath: string,
  projectPath: string,
): Promise<boolean> {
  const output = await git(
    ['worktree', 'list', '--porcelain'],
    projectPath,
    /* allowFailure */ true,
  );

  if (!output) return false;

  // Each entry starts with "worktree <absolute-path>"
  // The listed path and the expected one can spell the same folder differently (`\\wsl$\` vs
  // `\\wsl.localhost\`, either slash, any case), and a worktree that only looks unregistered is
  // deleted with the work in it — worktreePathKey() makes the two spellings compare equal
  const normalizedTarget = worktreePathKey(worktreePath);
  return output
    .split(/\r?\n/)
    .some((line) => {
      if (!line.startsWith('worktree ')) return false;
      // git in WSL lists Linux paths
      const listed = toHostPath(line.slice('worktree '.length).trim());
      return worktreePathKey(listed) === normalizedTarget;
    });
}
