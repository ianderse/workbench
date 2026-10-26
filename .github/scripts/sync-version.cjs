/**
 * The app version, worked out from the git history
 * ===============================================
 *
 * The version is not stored by hand but derived, so it says the same thing whatever happened to
 * the branch (a commit, an amend, a cherry-pick, a pull):
 * - major: the first number in package.json, never touched here. Raising it is the user's call,
 *   and the `v<major>.0.0` tag of that release is where the counting below starts
 * - minor: the pull requests merged into main since that tag that this branch has, whether it was
 *   cut after them or took them in by catching up with main. A merge made on the branch itself (a
 *   catch-up, a `git pull` of its own remote) is no pull request
 * - patch: the plain commits this branch has made since the newest of those merges it is built
 *   on, so a merge resets it to 0 (catching up with main does not)
 *
 * The `post-commit` hook runs this and folds the change into the commit that caused it; a merge is
 * made on GitHub, where no hook runs, so .github/workflows/version.yml does the same to the merge
 * commit. Running it on its own only prints the version a clean checkout already has.
 *
 * The release workflows take the published version from the release tag, so what is written here
 * is what the app reports in a development or a locally packaged build.
 */
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const lines = (out) => (out ? out.split('\n') : []);

const packagePath = join(root, 'package.json');
const packageText = readFileSync(packagePath, 'utf8');
const current = JSON.parse(packageText).version;
const major = current.split('.')[0];

const exists = (ref) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// Without the release tag there is nothing to count from: leave the version as it is rather than
// guess one (a shallow clone, or a major raised before its release was tagged)
const anchor = `v${major}.0.0`;
if (!exists(`refs/tags/${anchor}`)) {
  console.log(`[sync-version] no ${anchor} tag to count from, keeping ${current}`);
  process.exit(0);
}

/**
 * The merges that count are main's: those on main's own line (its first parents), each the merge
 * of a pull request. A merge made on a branch (catching up with main, or a `git pull` of its own
 * remote) is never one, whichever side main is on, so the branch counts the same as the main it
 * has taken in. A merge is known by its parents, which version.yml keeps when it rewrites a merge
 * commit on main, so the one this branch took in may not be the one main has now.
 *
 * Worked out from two listings rather than asked of git commit by commit, which ran up to three
 * git processes for every merge on every commit. Without main to compare with, the merges on this
 * branch's own line are taken for pull requests.
 */
const mainRef = ['refs/remotes/origin/main', 'refs/heads/main'].find(exists);
const parentsOf = new Map(lines(git('rev-list', '--parents', `${anchor}..HEAD`)).map((line) => {
  const [sha, ...parents] = line.split(' ');
  return [sha, parents.join(' ')];
}));
const pullRequests = mainRef
  ? new Set(lines(git('rev-list', '--first-parent', '--merges', '--parents', `${anchor}..${mainRef}`))
    .map((line) => line.split(' ').slice(1).join(' ')))
  : null;

const merges = new Map();
if (pullRequests) {
  for (const [sha, parents] of parentsOf) {
    if (pullRequests.has(parents)) merges.set(parents, sha);
  }
} else {
  for (const line of lines(git('rev-list', '--first-parent', '--merges', '--parents', `${anchor}..HEAD`))) {
    const [sha, ...parents] = line.split(' ');
    merges.set(parents.join(' '), sha);
  }
}
// --first-parent: only this branch's own history, so the commits a merge brought in are not
// counted again as patches after it
const patch = lines(git('rev-list', '--first-parent', '--no-merges', 'HEAD', '--not', anchor, ...merges.values())).length;
const version = `${major}.${merges.size}.${patch}`;

if (version === current) {
  console.log(`[sync-version] ${version}`);
  process.exit(0);
}

const quoted = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const field = new RegExp(`("version":\\s*)"${quoted(current)}"`);
writeFileSync(packagePath, packageText.replace(field, `$1"${version}"`));

// package-lock.json carries the same version twice (the lock itself and the root package); both
// sit above every dependency, so the first two are the ones to change
const lockPath = join(root, 'package-lock.json');
try {
  let left = 2;
  const lockText = readFileSync(lockPath, 'utf8');
  writeFileSync(
    lockPath,
    lockText.replace(new RegExp(field.source, 'g'), (match, prefix) =>
      left-- > 0 ? `${prefix}"${version}"` : match
    )
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(`[sync-version] ${current} -> ${version}`);
