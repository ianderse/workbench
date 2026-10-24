/**
 * Resolving the branch a task's worktree starts from.
 *
 * A task keeps the base branch it was created with, and that branch can be deleted or renamed
 * afterwards. Standing in for it with a branch that still exists would keep the task runnable,
 * but it would also build the task on code the user never asked for and say so only in a log
 * line: a silent start from the wrong base is a worse outcome than a task that stops and asks
 * which branch to use, because the diff it produces looks finished and reviews as if it were
 * based on the right thing. So nothing is ever substituted here. When the wanted branch cannot
 * be resolved the run fails with a message naming it, which leaves the task in a recoverable
 * state: the user picks another base branch in the task's dialog and starts it again.
 *
 * A base branch is whatever git can resolve, which includes a branch on any remote the repo
 * has (`upstream/main`), not only on origin.
 *
 * Resolution answers with the concrete ref it found (`findBaseBranchRef`), not with a yes or no,
 * because worktree creation has to start the task's branch from exactly the ref that was accepted
 * here. When the two looked for different things the check passed and `git worktree add` then
 * failed on a branch this module had just called fine - the late, git-level failure this module
 * exists to prevent - so there is one lookup and both callers use its answer.
 *
 * A branch nobody has fetched yet is still a branch the task can start from. A teammate pushes a
 * base branch, or the user types one into the task dialog or hands one to the Insights task tools,
 * and the local repository has never heard of it: looking only at the refs that are already there
 * would fail the task for a branch that plainly exists. So a lookup that finds nothing fetches the
 * branch once and looks again (`lookUpBaseBranchRef`), and only then gives up.
 *
 * The same holds one step further in: a lookup that wants the remote ref and finds only a local
 * branch has not found what it asked for either. `refs/remotes/origin/main` is missing in a repo
 * that has never fetched, in a single-branch clone, and in one whose remote was added after the
 * branch - and in all three the refs on disk would quietly turn a remote-first task start into a
 * local-first one, which is a run implemented on whatever the user happens to have locally. That
 * lookup fetches once as well, and re-reads the ref afterwards.
 *
 * Either way it is one fetch per lookup at most, and a lookup that already has the ref it wants
 * fetches nothing, so the ordinary task start costs the git calls it did before.
 *
 * "Never substitute" is about a branch the user chose - on the task, or as the project's main
 * branch. When nothing was chosen there is nothing to substitute for, and assuming `main` would
 * be a guess that fails on every repository whose default is `master`, so the repository is asked
 * what its default is instead (`resolveDefaultBaseBranch`).
 */

import { git } from './git-exec';

/** Whether a ref resolves in the repo */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref], { cwd, isolated: true });
    return true;
  } catch {
    return false;
  }
}

/** The repo's remotes, or none when they can't be listed */
async function listRemotes(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await git(['remote'], { cwd, isolated: true });
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface BaseBranchRefOptions {
  /**
   * Prefer the local branch over the same name on a remote. This is the task's `useLocalBranch`:
   * a worktree started from the local branch keeps the files a fetched remote ref knows nothing
   * about, while the remote ref is the fresher starting point when the local branch has fallen
   * behind. Off by default, which matches the remote-first default of task worktrees.
   *
   * It also decides whether `lookUpBaseBranchRef` will fetch to get the remote ref it prefers:
   * asking for the local branch is asking for the branch as it is here, local-only files and all,
   * so that lookup never fetches a remote ref out from under it.
   */
  preferLocal?: boolean;
}

/**
 * The refs a base branch name can mean, in the order a tie between them is broken.
 *
 * The order is fixed rather than first-match-wins over `git remote` so that two repositories with
 * the same branches resolve the same way, and so that a repository that gains a second remote does
 * not silently move a task's base: the branch the user works on locally comes first (or last, when
 * the remote ref was asked for), then origin, which is the remote the project itself publishes to
 * and pushes task branches to, and only then the other remotes in the order git lists them, which
 * is a fork's or a second upstream's. Exported so a caller that found nothing can say what it
 * looked for.
 */
export async function baseBranchRefCandidates(
  cwd: string,
  branch: string,
  options: BaseBranchRefOptions = {}
): Promise<string[]> {
  // A name that already carries its remote (`upstream/main`) is a ref under refs/remotes as it
  // stands; for a plain name that ref simply does not exist, so trying it costs nothing
  const remoteRefs = [`refs/remotes/${branch}`];
  // A plain name can be a branch on any remote, not just origin: a task may have been created
  // from a fork or from a second upstream the project tracks
  const remotes = await listRemotes(cwd);
  for (const remote of [...remotes].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'))) {
    remoteRefs.push(`refs/remotes/${remote}/${branch}`);
  }
  const localRef = `refs/heads/${branch}`;
  return options.preferLocal ? [localRef, ...remoteRefs] : [...remoteRefs, localRef];
}

/**
 * The ref a base branch name resolves to (`refs/heads/dev`, `refs/remotes/upstream/dev`), or null
 * when the repo has no branch by that name. The ref is fully qualified, so it is unambiguous and
 * can be handed to `git worktree add` as a start point as it is.
 */
export async function findBaseBranchRef(
  cwd: string,
  branch: string,
  options: BaseBranchRefOptions = {}
): Promise<string | null> {
  for (const ref of await baseBranchRefCandidates(cwd, branch, options)) {
    if (await refExists(cwd, ref)) return ref;
  }
  return null;
}

/**
 * Whether a branch resolves in the repo, as a local branch or on any of its remotes. This looks
 * only at the refs the repo already has: it never fetches, so it is safe for a dialog or a list
 * to call, and for the name sweep in `resolveDefaultBaseBranch` to call several times over.
 */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  // Which ref wins does not matter to a yes-or-no question, so the cheaper local-first order is
  // used: most base branches are branches the user has locally
  return (await findBaseBranchRef(cwd, branch, { preferLocal: true })) !== null;
}

/**
 * How long a fetch for a base branch may take. `git()` applies no timeout of its own, so without
 * one a remote that opens the connection and then stops answering (a half-connected VPN, an SSH
 * host waiting for a passphrase that nothing can type) would hold a task start open indefinitely.
 */
const FETCH_TIMEOUT_MS = 30_000;

/** A fetch that can bring a base branch in: the remote to ask, and the branch's name on it */
export interface BaseBranchFetch {
  /** The remote, as `git remote` names it */
  remote: string;
  /** The name the branch has on that remote, which is the base branch name without its prefix */
  branch: string;
}

/**
 * The fetch that refreshes a resolved base branch ref, or null for a local branch, which no fetch
 * of a remote can move.
 *
 * Both halves come from the ref: `refs/remotes/upstream/release` is `release` on `upstream`, and
 * asking that remote for `upstream/release` instead would be a refspec no remote has, which git
 * rejects outright. Deriving only the remote and reusing the base branch name as the refspec is
 * the trap here, because the fetch is best-effort: the rejection is swallowed and the worktree is
 * then cut from whatever the last fetch that did work left behind, which is stale code the agent
 * implements on while the log line claims the branch was just refreshed.
 */
export function baseBranchFetchForRef(ref: string): BaseBranchFetch | null {
  const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
  return match ? { remote: match[1], branch: match[2] } : null;
}

/**
 * Fetch one base branch from one remote. Best-effort by design: a repo can be offline, have no
 * such remote, or have no credentials for it, and none of that should stop a task that the refs
 * already on disk can serve. Bounded by FETCH_TIMEOUT_MS so it cannot hang the start either.
 */
export async function fetchBaseBranch(cwd: string, target: BaseBranchFetch): Promise<void> {
  try {
    await git(['fetch', target.remote, target.branch], { cwd, isolated: true, timeout: FETCH_TIMEOUT_MS });
  } catch {
    // The caller carries on with the refs it has, and reports a missing branch if it has none
  }
}

/**
 * The single fetch worth trying for a base branch whose remote ref the repo does not have yet -
 * whether the name resolves to nothing at all or only to a local branch - or null when the repo
 * has no remote to ask.
 *
 * One remote, not every remote the repo has: this runs while the user waits for a task to start,
 * and a sweep over several remotes would be several connections one after another, each able to
 * sit there until the timeout when the network is down. The one it picks is the remote the name
 * itself names (`upstream/dev` can only mean `dev` on `upstream`), and failing that `origin`,
 * which is the remote the project publishes to and the one a teammate's pushed branch is on. A
 * plain name that lives only on a second upstream and was never fetched is the case this gives
 * up on, and it gives up with the message naming the branch rather than with a git error.
 */
async function fetchTargetForBranch(cwd: string, branch: string): Promise<BaseBranchFetch | null> {
  const remotes = await listRemotes(cwd);
  const [first, ...rest] = branch.split('/');
  if (rest.length > 0 && remotes.includes(first)) return { remote: first, branch: rest.join('/') };
  return remotes.includes('origin') ? { remote: 'origin', branch } : null;
}

/** What a base branch lookup found, and what refreshing it takes */
export interface BaseBranchLookup {
  /** The ref the branch resolves to, after one fetch when the lookup did not have the ref it wanted */
  ref: string | null;
  /** The fetch that refreshes that ref, when it is a branch on a remote */
  fetch: BaseBranchFetch | null;
  /** Whether that fetch has already run, because this lookup did not have the ref it wanted */
  fetched: boolean;
}

/**
 * The ref a base branch resolves to, fetching once when the repo does not have the ref this lookup
 * wants.
 *
 * Both callers that decide whether a task can start go through this - the run config
 * (agent/agent-manager) and worktree creation (worktree/worktree-manager) - so the two cannot
 * come to different answers about the same branch again. It reports the fetch that belongs to
 * the ref it found, and whether that fetch has already happened, so creation can refresh the
 * ref it is about to branch from without fetching the same thing twice.
 *
 * Two cases are worth that fetch, and both are a ref the repo has not got rather than a ref it
 * could have refreshed. The first is a name that resolves to nothing: the branch exists on a
 * remote nobody has fetched since it was pushed. The second is a remote-first lookup that found
 * only a local branch: `refs/remotes/origin/main` is simply absent in a repo that has never
 * fetched, in a single-branch clone, and in one whose remote was added after the branch, so
 * answering with `refs/heads/main` there would hand a caller that asked for the remote a
 * local-first start point without ever saying so - and the task would be implemented on the
 * user's local code. Each case fetches once and looks again, because the second look is the
 * whole point: a fetch nothing re-reads leaves the stale answer in place.
 *
 * Nothing is fetched when the first look already found the ref this lookup wants, which is the
 * ordinary task start in a repo that is kept fetched.
 */
export async function lookUpBaseBranchRef(
  cwd: string,
  branch: string,
  options: BaseBranchRefOptions = {}
): Promise<BaseBranchLookup> {
  const known = await findBaseBranchRef(cwd, branch, options);
  // A local branch is the answer a `preferLocal` lookup asked for, and only the second best for
  // one that wants the remote ref, which is what makes it worth a fetch here
  if (known !== null && (options.preferLocal === true || !known.startsWith('refs/heads/'))) {
    return { ref: known, fetch: baseBranchFetchForRef(known), fetched: false };
  }

  const target = await fetchTargetForBranch(cwd, branch);
  // With no remote to ask, the local branch (or nothing) is as good as this gets
  if (!target) return { ref: known, fetch: null, fetched: false };

  await fetchBaseBranch(cwd, target);
  // The fetch is best-effort, so this can be the same local ref as before - offline, no
  // credentials, or a remote that does not carry the branch - and the task then starts from it
  const fetchedRef = (await findBaseBranchRef(cwd, branch, options)) ?? known;
  return { ref: fetchedRef, fetch: fetchedRef ? baseBranchFetchForRef(fetchedRef) : null, fetched: true };
}

/**
 * The branch a task starts from, which is always the branch it asked for.
 *
 * This throws rather than hand back a branch git can't use, and rather than quietly pick a
 * different one: the task would otherwise be built on unrelated code, or fail later with git's
 * own "invalid reference", and either way the user would not learn which branch is missing.
 * The message is read by the user in the failed task, so it says what to do next.
 *
 * Running on the task-start path, this is the one place allowed to fetch for a branch the repo
 * has never seen: it decides whether the task starts at all, and it decides it before worktree
 * creation gets a chance to fetch anything.
 */
export async function resolveBaseBranch(cwd: string, wanted: string): Promise<string> {
  // Local-first here: which of the two refs wins does not change the yes-or-no answer, and asking
  // for the local one keeps validation from fetching a remote ref it does not need. The branch it
  // accepts is still one creation can start from, because creation looks for the same name and may
  // only end up on a fresher ref for it; the fetch that gets that ref belongs there, where the
  // worktree is actually cut, and happens once.
  const { ref } = await lookUpBaseBranchRef(cwd, wanted, { preferLocal: true });
  if (ref) return wanted;
  throw new Error(
    `Base branch "${wanted}" does not exist locally or on any remote. It may have been deleted `
      + 'or renamed since the task was created. Give the task a base branch that exists and '
      + 'start it again.'
  );
}

/** The branch `origin/HEAD` points at, which is the repository's own answer when it is set */
async function originDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd, isolated: true });
    // `origin/main` names the branch `main`
    const branch = stdout.trim().replace(/^origin\//, '');
    return branch || null;
  } catch {
    // The repo has no origin, or nothing set its HEAD
    return null;
  }
}

/** The branch currently checked out, or null in an empty repo or a detached HEAD */
async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, isolated: true });
    const branch = stdout.trim();
    return !branch || branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/** Names a repository's default branch usually goes by, tried in this order */
const DEFAULT_BRANCH_NAMES = ['main', 'master', 'develop', 'dev', 'trunk'];

/**
 * The branch to start from when neither the task nor the project named one.
 *
 * Asking the repository beats assuming: `origin/HEAD` is the answer when it is set, otherwise the
 * usual default names are tried in turn, and failing those the branch that is checked out - which
 * in a repo with one oddly named branch is the only sensible base there is. Only a repository with
 * no resolvable branch at all (a fresh `git init` with no commit) has no answer, and that is
 * reported rather than guessed at.
 *
 * Every candidate is accepted through the same lookup a chosen branch goes through, so the name
 * that comes back is one worktree creation can start a branch from - `main` is a good default here
 * when it is only `upstream/main`, because that is the ref the worktree will then be cut from.
 *
 * Deliberately the non-fetching lookup, unlike a branch the user chose: these names are guesses,
 * and fetching for each of them would be a run of connections for branches nobody asked for. The
 * consistency that matters holds anyway - every name this hands back already resolves on disk, so
 * worktree creation can start from it, and the at most one fetch it may still run for that name is
 * the ordinary one that gets the remote's version of the branch the task starts from.
 */
export async function resolveDefaultBaseBranch(cwd: string): Promise<string> {
  const fromOrigin = await originDefaultBranch(cwd);
  if (fromOrigin && (await branchExists(cwd, fromOrigin))) return fromOrigin;

  for (const name of DEFAULT_BRANCH_NAMES) {
    if (await branchExists(cwd, name)) return name;
  }

  const checkedOut = await currentBranch(cwd);
  if (checkedOut && (await branchExists(cwd, checkedOut))) return checkedOut;

  throw new Error(
    'This project has no branch to start the task from. Commit something on a branch, or give '
      + 'the task a base branch, and start it again.'
  );
}
