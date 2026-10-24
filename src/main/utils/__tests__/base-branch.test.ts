/**
 * A task keeps the base branch it was created with, and no other branch ever stands in for it:
 * when the branch it asked for is gone, resolving fails with a message naming it, so the user
 * can give the task a branch that exists instead of getting a run built on the wrong code. A
 * branch on any remote the repo has (`upstream/main`) is one git can resolve, so it is kept.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

vi.mock('../../cli-tool-manager', () => ({
  getToolPath: () => 'git',
  getToolPathAsync: async () => 'git'
}));

import { branchExists, findBaseBranchRef, resolveBaseBranch, resolveDefaultBaseBranch } from '../base-branch';
import { getIsolatedGitEnv } from '../git-isolation';
import { createOrGetWorktree } from '../../worktree';

let tmp: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: getIsolatedGitEnv() }).trim();

function initRepo(): string {
  const repo = path.join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, '.gitignore'), '.workbench/\n');
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

/**
 * A remote with a fetched branch, the way a fork or a second upstream looks after a fetch. The
 * branch points at HEAD unless a commit is given, which the worktree tests use to put the remote
 * branch on a commit the local branches are not on, so the worktree's HEAD proves where it started.
 */
function addRemoteBranch(repo: string, remote: string, branch: string, at?: string): void {
  git(repo, 'remote', 'add', remote, `https://example.invalid/${remote}.git`);
  git(repo, 'update-ref', `refs/remotes/${remote}/${branch}`, at ?? git(repo, 'rev-parse', 'HEAD'));
}

/**
 * A repo on disk that can really be fetched from, with its first commit on `branch`. Fetching a
 * path needs no network, so a test can prove a fetch happened by the commit it brought in - and
 * prove one did not happen by the commit that is still missing.
 */
function initFetchableRepo(name: string, branch: string): string {
  const repo = path.join(tmp, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', branch);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'README.md'), 'first\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  return repo;
}

/** A commit on the branch that is checked out, without touching any other branch */
function commitOnHead(repo: string, text: string): string {
  writeFileSync(path.join(repo, 'README.md'), `${text}\n`);
  git(repo, 'commit', '-q', '-am', text);
  return git(repo, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'base-branch-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('branchExists', () => {
  it('finds a local branch and misses one that was never created', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');

    expect(await branchExists(repo, 'develop')).toBe(true);
    expect(await branchExists(repo, 'gone')).toBe(false);
  });

  it('finds a branch on a remote that is not origin', async () => {
    const repo = initRepo();
    addRemoteBranch(repo, 'upstream', 'main');

    expect(await branchExists(repo, 'upstream/main')).toBe(true);
    expect(await branchExists(repo, 'upstream/release')).toBe(false);
  });

  it('finds a plain name on any remote the repo has', async () => {
    const repo = initRepo();
    addRemoteBranch(repo, 'fork', 'experiment');

    expect(await branchExists(repo, 'experiment')).toBe(true);
  });
});

/**
 * The ref, not a yes or no: worktree creation starts the task's branch from exactly this, so the
 * tie-breaking between a local branch and the same name on several remotes is part of the contract.
 */
describe('findBaseBranchRef', () => {
  it('answers with the concrete ref a plain name resolves to', async () => {
    const repo = initRepo();
    addRemoteBranch(repo, 'fork', 'experiment');

    expect(await findBaseBranchRef(repo, 'experiment')).toBe('refs/remotes/fork/experiment');
    expect(await findBaseBranchRef(repo, 'gone')).toBeNull();
  });

  it('prefers origin over the repo\'s other remotes', async () => {
    const repo = initRepo();
    // `git remote` lists these alphabetically, so a first-match-wins order would pick the fork
    addRemoteBranch(repo, 'fork', 'release');
    addRemoteBranch(repo, 'origin', 'release');
    addRemoteBranch(repo, 'upstream', 'release');

    expect(await findBaseBranchRef(repo, 'release')).toBe('refs/remotes/origin/release');
  });

  it('follows the task\'s local-or-remote choice when the name exists on both sides', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'dev');
    addRemoteBranch(repo, 'origin', 'dev');

    expect(await findBaseBranchRef(repo, 'dev', { preferLocal: true })).toBe('refs/heads/dev');
    expect(await findBaseBranchRef(repo, 'dev')).toBe('refs/remotes/origin/dev');
  });
});

describe('resolveBaseBranch', () => {
  it('keeps the branch the task asked for while it exists', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');

    expect(await resolveBaseBranch(repo, 'develop')).toBe('develop');
  });

  it('fails and names the branch when the one the task asked for was deleted', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');
    git(repo, 'branch', '-D', 'develop');

    // The user reads this on the failed task, so it has to say which branch is gone
    await expect(resolveBaseBranch(repo, 'develop')).rejects.toThrow(
      /Base branch "develop" does not exist locally or on any remote/
    );
    await expect(resolveBaseBranch(repo, 'develop')).rejects.toThrow(
      /base branch that exists and start it again/
    );
  });

  it('never hands back a branch other than the one that was asked for', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');
    addRemoteBranch(repo, 'upstream', 'release');

    // Every branch that could have stood in for the missing one is right there (main, develop,
    // upstream/release, and the branch that is checked out), and none of them comes back
    const resolved = await resolveBaseBranch(repo, 'feature/gone').catch(() => undefined);

    expect(resolved).toBeUndefined();
    await expect(resolveBaseBranch(repo, 'feature/gone')).rejects.toThrow(/"feature\/gone"/);
  });

  it('keeps a base branch that only exists on another remote', async () => {
    const repo = initRepo();
    addRemoteBranch(repo, 'upstream', 'main');

    expect(await resolveBaseBranch(repo, 'upstream/main')).toBe('upstream/main');
  });

  it('keeps a plain name that only exists on a remote that is not origin', async () => {
    const repo = initRepo();
    addRemoteBranch(repo, 'fork', 'experiment');

    expect(await resolveBaseBranch(repo, 'experiment')).toBe('experiment');
  });
});

/**
 * The branch validation accepts has to be the branch worktree creation can start from: the two
 * share one lookup, so a base branch resolving here and failing there - with git's own "invalid
 * reference", at the point where the task is already running - cannot happen.
 *
 * `example.invalid` is never a remote URL here: step 5 of creation fetches from origin, and a
 * remote pointing at a path that simply isn't there fails at once without touching the network.
 */
describe('createOrGetWorktree and the base branch it starts from', () => {
  /** A remote whose fetches fail immediately, so only its fetched refs matter */
  const addOfflineRemote = (repo: string, remote: string) =>
    git(repo, 'remote', 'add', remote, path.join(tmp, `no-such-${remote}.git`));

  it('says which branch is missing instead of failing on an invalid reference', async () => {
    const repo = initRepo();

    await expect(createOrGetWorktree(repo, '014-task', 'develop', false, false))
      .rejects.toThrow(/Base branch "develop" does not exist/);
  });

  it('names the refs it looked for, including the remotes the repo actually has', async () => {
    const repo = initRepo();
    addOfflineRemote(repo, 'upstream');

    // The old message claimed only `develop` and `origin/develop` were tried, which told a user
    // with a fork nothing about where the branch was looked for
    const failure = await createOrGetWorktree(repo, '014-task', 'develop', false, false).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('refs/remotes/upstream/develop');
    expect((failure as Error).message).toContain('refs/heads/develop');
  });

  it('branches from the base branch that is there', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'develop');
    writeFileSync(path.join(repo, 'README.md'), 'moved on\n');
    git(repo, 'commit', '-q', '-am', 'move main on');

    const worktree = await createOrGetWorktree(repo, '014-task', 'develop', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'develop'));
  });

  it('starts from a base branch that only exists on a remote other than origin', async () => {
    const repo = initRepo();
    // A fork setup: `dev` was never fetched into origin, it lives on `upstream` only
    const forked = git(repo, 'rev-parse', 'HEAD');
    addOfflineRemote(repo, 'origin');
    addRemoteBranch(repo, 'upstream', 'dev', forked);
    const moved = commitOnHead(repo, 'main moved on');

    // Validation hands `dev` to the run, so creation has to be able to cut a worktree from it
    expect(await resolveBaseBranch(repo, 'dev')).toBe('dev');

    const worktree = await createOrGetWorktree(repo, '015-fork-task', 'dev', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(forked);
    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).not.toBe(moved);
    expect(git(worktree.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('workbench/015-fork-task');
  });

  it('starts from a name that already carries its remote', async () => {
    const repo = initRepo();
    const forked = git(repo, 'rev-parse', 'HEAD');
    addRemoteBranch(repo, 'upstream', 'main', forked);
    commitOnHead(repo, 'main moved on');

    const worktree = await createOrGetWorktree(repo, '016-upstream-task', 'upstream/main', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(forked);
  });

  it('prefers the local branch when the task asked for it, and the remote ref otherwise', async () => {
    const repo = initRepo();
    git(repo, 'branch', 'dev');
    const local = git(repo, 'rev-parse', 'dev');
    // The same branch, fetched from origin at a later commit than the local one
    const fetched = commitOnHead(repo, 'origin moved on');
    addOfflineRemote(repo, 'origin');
    git(repo, 'update-ref', 'refs/remotes/origin/dev', fetched);

    const localWorktree = await createOrGetWorktree(repo, '017-local', 'dev', true, false);
    const remoteWorktree = await createOrGetWorktree(repo, '017-remote', 'dev', false, false);

    expect(git(localWorktree.worktreePath, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(remoteWorktree.worktreePath, 'rev-parse', 'HEAD')).toBe(fetched);
  });

  it('starts from the default base branch when that name only exists on a remote', async () => {
    // Nothing local is named like a default branch, so `resolveDefaultBaseBranch` answers with
    // `main` because `upstream/main` is fetched - and the worktree has to come from that ref
    const repo = path.join(tmp, 'repo-wip');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'wip');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, '.gitignore'), '.workbench/\n');
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const fetched = git(repo, 'rev-parse', 'HEAD');
    addRemoteBranch(repo, 'upstream', 'main', fetched);
    const moved = commitOnHead(repo, 'wip moved on');

    const baseBranch = await resolveDefaultBaseBranch(repo);
    expect(baseBranch).toBe('main');

    const worktree = await createOrGetWorktree(repo, '018-default', baseBranch, false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(fetched);
    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).not.toBe(moved);
  });
});

/**
 * With no base branch chosen anywhere there is no choice to honour, so the repository is asked what
 * its default is. Assuming `main` would have stopped every `master` repository from running a task
 * at all once substitution was removed.
 */
describe('resolveDefaultBaseBranch', () => {
  /** A repo whose only branch is named `branch`, as `git init` leaves it */
  function initRepoOn(branch: string): string {
    const repo = path.join(tmp, `repo-${branch.replace(/\//g, '-')}`);
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', branch);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    return repo;
  }

  it('uses master in a repo that has no main', async () => {
    const repo = initRepoOn('master');

    await expect(resolveDefaultBaseBranch(repo)).resolves.toBe('master');
  });

  it('prefers what origin/HEAD points at over the usual names', async () => {
    const repo = initRepoOn('main');
    git(repo, 'branch', 'release');
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/origin.git');
    git(repo, 'update-ref', 'refs/remotes/origin/release', git(repo, 'rev-parse', 'release'));
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');

    await expect(resolveDefaultBaseBranch(repo)).resolves.toBe('release');
  });

  it('falls back to the branch that is checked out when nothing is named usually', async () => {
    const repo = initRepoOn('shipping');

    await expect(resolveDefaultBaseBranch(repo)).resolves.toBe('shipping');
  });

  it('says so when the repo has no branch at all', async () => {
    const repo = path.join(tmp, 'empty');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');

    await expect(resolveDefaultBaseBranch(repo)).rejects.toThrow(/no branch to start the task from/);
  });
});

/**
 * The worktree is cut from the base branch's own remote, so that remote is the one refreshed.
 * Fetching origin for a branch that lives on a fork or a second upstream left the task starting
 * from whatever happened to be fetched last, which looks like a worktree built from stale code.
 */
describe('createOrGetWorktree and the remote it refreshes', () => {
  it('fetches the remote the base branch actually lives on', async () => {
    // A real second remote, so the fetch either works or demonstrably does not
    const upstream = initFetchableRepo('upstream', 'dev');

    const repo = initRepo();
    git(repo, 'remote', 'add', 'upstream', upstream);
    git(repo, 'fetch', '-q', 'upstream', 'dev');

    // Upstream moves on after that fetch, so only a fresh fetch of `upstream` can see it
    const moved = commitOnHead(upstream, 'second');
    expect(git(repo, 'rev-parse', 'refs/remotes/upstream/dev')).not.toBe(moved);

    const worktree = await createOrGetWorktree(repo, '015-task', 'dev', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(moved);
  });
});

/**
 * The refspec is part of "the remote the branch lives on": a base branch that carries its remote
 * in its own name (`upstream/main`) is `main` on `upstream`, and asking `upstream` for
 * `upstream/main` is a refspec no remote has. git rejects it, the best-effort fetch swallows the
 * rejection, and the worktree is then cut from whatever the last fetch that did work left behind.
 */
describe('createOrGetWorktree and a base branch that carries its remote', () => {
  it('refreshes it under the name its remote knows it by', async () => {
    const upstream = initFetchableRepo('upstream-main', 'main');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'upstream', upstream);
    git(repo, 'fetch', '-q', 'upstream', 'main');

    // Upstream moves on after that fetch, so the worktree can only be on this commit if the fetch
    // creation ran was one `upstream` accepted
    const moved = commitOnHead(upstream, 'second');
    expect(git(repo, 'rev-parse', 'refs/remotes/upstream/main')).not.toBe(moved);

    const worktree = await createOrGetWorktree(repo, '016-upstream-main', 'upstream/main', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(moved);
  });
});

/**
 * A branch nobody has fetched yet is still a branch the task can start from: a teammate pushes the
 * base branch, or it arrives as typed text through the task dialog or the Insights task tools, and
 * the repo here has never heard of it. Deciding existence from the refs on disk alone failed those
 * tasks outright, so a lookup that finds nothing fetches the branch once and looks again - while a
 * lookup that finds something stays as local as it ever was.
 */
describe('a base branch that exists on a remote but has not been fetched', () => {
  it('starts a task from a branch that was pushed since the last fetch', async () => {
    const origin = initFetchableRepo('origin-pushed', 'dev');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', origin);
    const pushed = git(origin, 'rev-parse', 'dev');

    // Nothing on disk knows this branch: the non-fetching lookup is the state the run starts in
    expect(await findBaseBranchRef(repo, 'dev')).toBeNull();

    // Validation runs first and must not fail the task over a branch that plainly exists
    expect(await resolveBaseBranch(repo, 'dev')).toBe('dev');

    const worktree = await createOrGetWorktree(repo, '019-pushed', 'dev', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(pushed);
  });

  it('creates the worktree on its own when the fetch has to bring the branch in first', async () => {
    // Creation is reached again on a retry, with its own resolution, so it cannot lean on
    // validation having fetched the branch earlier
    const origin = initFetchableRepo('origin-release', 'release');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', origin);

    const worktree = await createOrGetWorktree(repo, '020-release', 'release', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'release'));
  });

  it('asks the remote the name itself names, not the default one', async () => {
    const upstream = initFetchableRepo('upstream-feature', 'dev');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'upstream', upstream);
    // origin is where a fetch would go by default, and it is not where this branch is; its URL is
    // a path that does not exist, so a fetch of it fails at once without touching the network
    git(repo, 'remote', 'add', 'origin', path.join(tmp, 'no-such-origin.git'));

    expect(await resolveBaseBranch(repo, 'upstream/dev')).toBe('upstream/dev');

    const worktree = await createOrGetWorktree(repo, '021-upstream', 'upstream/dev', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(git(upstream, 'rev-parse', 'dev'));
  });

  it('does not fetch at all for a base branch that already resolves', async () => {
    const origin = initFetchableRepo('origin-ahead', 'dev');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'fetch', '-q', 'origin', 'dev');
    const known = git(repo, 'rev-parse', 'refs/remotes/origin/dev');

    // origin gains a commit that only a fetch could reveal here
    const moved = commitOnHead(origin, 'origin moved on');
    expect(moved).not.toBe(known);

    expect(await resolveBaseBranch(repo, 'dev')).toBe('dev');

    // The ordinary task start has to stay as cheap as it was: the retry is for the miss only
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/dev')).toBe(known);
  });

  it('still names the branch when a fetch cannot find it either', async () => {
    const origin = initFetchableRepo('origin-main', 'main');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', origin);

    // The user reads this, so a branch that exists nowhere has to fail here and not later with
    // git's own "invalid reference" once the run is already under way
    await expect(resolveBaseBranch(repo, 'never-existed')).rejects.toThrow(
      /Base branch "never-existed" does not exist locally or on any remote/
    );
    await expect(createOrGetWorktree(repo, '022-missing', 'never-existed', false, false)).rejects.toThrow(
      /Base branch "never-existed" does not exist in this repository/
    );
  });
});

/**
 * With `useLocalBranch` off the worktree starts from what the remote has: that is the documented
 * default, and the reason a task is cut from the branch as it was pushed rather than from whatever
 * the user has sitting in their own checkout. The refs on disk are not enough to honour it - a repo
 * that has never fetched, a single-branch clone and a repo whose remote was added after the branch
 * all have the branch locally and no `refs/remotes/origin/<branch>` - so a remote-first lookup that
 * lands on a local branch fetches once and resolves again. `useLocalBranch` on is the opposite ask
 * and must not be fetched out from under: it exists to preserve files a fetched ref knows nothing
 * about.
 */
describe('createOrGetWorktree and the remote-first default', () => {
  it('starts from the remote branch when only a local one has ever been on disk', async () => {
    const origin = initFetchableRepo('origin-never-fetched', 'dev');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', origin);
    // The branch exists locally and the remote ref does not, which is the whole trap: resolving
    // from the refs that are there would answer `refs/heads/dev` and never fetch
    git(repo, 'branch', 'dev');
    const local = git(repo, 'rev-parse', 'dev');
    expect(await findBaseBranchRef(repo, 'dev')).toBe('refs/heads/dev');

    const worktree = await createOrGetWorktree(repo, '023-remote-first', 'dev', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'dev'));
    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).not.toBe(local);
  });

  it('keeps the local branch when the task asked for it, without fetching the remote one in', async () => {
    const origin = initFetchableRepo('origin-local-wanted', 'dev');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'branch', 'dev');
    const local = git(repo, 'rev-parse', 'dev');

    const worktree = await createOrGetWorktree(repo, '024-local-wanted', 'dev', true, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(local);
    // Nothing fetched the remote ref either: a fetch-and-switch here would be the same regression
    // in the other direction, a task started from code the user's local-only files do not match
    expect(await findBaseBranchRef(repo, 'dev')).toBe('refs/heads/dev');
  });

  it('refreshes the remote the name itself names when only a local branch is on disk', async () => {
    const upstream = initFetchableRepo('upstream-unfetched', 'main');
    const repo = initRepo();
    git(repo, 'remote', 'add', 'upstream', upstream);
    // origin is where a fetch goes by default and is not where this branch lives; its URL is a
    // path that is not there, so asking it fails at once without touching the network
    git(repo, 'remote', 'add', 'origin', path.join(tmp, 'no-such-origin.git'));
    // `upstream/main` is `main` on `upstream`: asking `upstream` for `upstream/main` is a refspec
    // no remote has, git rejects it, and the best-effort fetch would swallow the rejection
    const local = git(repo, 'rev-parse', 'HEAD');

    const worktree = await createOrGetWorktree(repo, '025-upstream-unfetched', 'upstream/main', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(git(upstream, 'rev-parse', 'main'));
    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).not.toBe(local);
  });

  it('starts from the local branch when no fetch can reach the remote', async () => {
    const repo = initRepo();
    // Offline, no credentials and a remote that is simply not there all look like this: the task
    // has to run from the refs the repo does have rather than fail for want of a fetch
    git(repo, 'remote', 'add', 'origin', path.join(tmp, 'no-such-origin.git'));
    const local = git(repo, 'rev-parse', 'HEAD');

    const worktree = await createOrGetWorktree(repo, '026-offline', 'main', false, false);

    expect(git(worktree.worktreePath, 'rev-parse', 'HEAD')).toBe(local);
    expect(git(worktree.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('workbench/026-offline');
  });
});

/**
 * Pruning against real git, because what the prune has to read is git's own report of what it would
 * remove - and git writes that to stderr. A mocked git cannot settle which stream it comes on, and
 * reading the wrong one makes the plan look empty, which reads as "nothing to prune" and turns the
 * prune off without a word.
 */
describe('createOrGetWorktree and a worktree folder that was deleted', () => {
  it('clears the dead registration so the task can start again', async () => {
    const repo = initRepo();
    const first = await createOrGetWorktree(repo, '027-task', 'main', true, false);
    expect(git(first.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('workbench/027-task');

    // The user deletes the folder outside the app; git still has the registration, and it still
    // claims the task's branch
    rmSync(first.worktreePath, { recursive: true, force: true });
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('027-task');

    const again = await createOrGetWorktree(repo, '027-task', 'main', true, false);

    expect(git(again.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('workbench/027-task');
  });
});
