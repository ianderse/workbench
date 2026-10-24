/**
 * Worktrees shared by Windows git and WSL git
 * ===========================================
 *
 * On Windows a project can be used by Windows git (the pwsh shell) and by WSL git (the wsl
 * shell, Settings > General). git links a linked worktree and the main repository with absolute
 * paths in the format of the git that created it (`C:/...` or `/mnt/c/...`), which the other git
 * can't follow: it reports the worktree as broken, and `git worktree prune` would even drop it.
 *
 * - New worktrees get relative links (`worktree.useRelativePaths`, git 2.48+) when every git that
 *   may open the repository supports them: relative links set the `relativeWorktrees` repository
 *   extension, and older git then refuses the whole repository. That is both runtimes' git on
 *   Windows, and on macOS also the system git (`/usr/bin/git`, Xcode's), which other tools run
 *   even when a newer Homebrew git comes first on PATH.
 * - Links in the other runtime's format are repaired (`git worktree repair <paths>`) before a
 *   prune, and for every project when the app starts in a different runtime than last time.
 *
 * No electron imports: worktree creation imports this.
 */

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { appLog } from '../app-logger';
import { getToolInfoAsync } from '../cli-tool-manager';
import { isMacOS, isWindows } from '../platform';
import { runTool } from '../platform/runtime-exec';
import { getWslInfo, isWslRuntime } from '../platform/shell-runtime';
import { isWslUncPath, windowsPathKey, wslToWindows } from '../platform/wsl-paths';
import { git } from '../utils/git-exec';

/** First git version with `worktree.useRelativePaths` */
export const RELATIVE_WORKTREES_MIN_GIT = [2, 48] as const;

/** git config that makes git write relative worktree links */
export const RELATIVE_WORKTREES_CONFIG = ['-c', 'worktree.useRelativePaths=true'] as const;

/** Whether a git version ("2.48.1", "2.53.0.windows.1") writes relative worktree links */
export function gitSupportsRelativeWorktrees(version: string | null | undefined): boolean {
  const match = version?.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [minMajor, minMinor] = RELATIVE_WORKTREES_MIN_GIT;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * git versions per runtime on Windows: a version, null when that runtime has no git, undefined
 * when unknown (the other runtime's version comes from the last session that used it)
 */
export interface RuntimeGitVersions {
  native?: string | null;
  wsl?: string | null;
}

let knownVersions: RuntimeGitVersions = {};

/** Where the last WSL session mounted Windows drives, to read its links from a native session */
export interface WslPathHints {
  distro?: string;
  mountRoot?: string;
}

let wslHints: WslPathHints = {};

/** Set at startup (runtime-switch.ts) from this session and the stored state of earlier ones */
export function setKnownGitVersions(versions: RuntimeGitVersions): void {
  knownVersions = { ...versions };
}

export function setWslPathHints(hints: WslPathHints | undefined): void {
  wslHints = { ...(hints ?? {}) };
}

/**
 * macOS ships git at this path (Xcode's, 2.39 at the time of writing). Homebrew git can be first
 * on PATH while Xcode, IDEs and other tools still run this one, so it also has to be able to read
 * the repository.
 */
const MACOS_SYSTEM_GIT = '/usr/bin/git';

const SYSTEM_GIT_TIMEOUT_MS = 10_000;

/** Whether macOS's system git reads relative links; undefined until asked, probed once */
let macosSystemGitRelative: boolean | undefined;

/** Back to the startup state (tests) */
export function resetRuntimeWorktreesForTests(): void {
  knownVersions = {};
  wslHints = {};
  macosSystemGitRelative = undefined;
}

/** The git of the runtime this session runs its tools in */
async function currentGit(): Promise<{ version: string | null; path: string | null }> {
  const wsl = getWslInfo();
  if (wsl) return { version: wsl.tools.git.path ? wsl.tools.git.version : null, path: wsl.tools.git.path };
  const info = await getToolInfoAsync('git');
  return { version: info.found ? info.version ?? null : null, path: info.found ? info.path ?? null : null };
}

/**
 * Whether macOS's system git could read relative worktree links (true off macOS, and when there
 * is no `/usr/bin/git`). A repository with relative links sets the `relativeWorktrees` extension,
 * which older git refuses altogether — so when that git doesn't answer, or is older than 2.48,
 * new worktrees get absolute links, which every git can open.
 */
async function macosSystemGitSupportsRelative(currentGitPath: string | null): Promise<boolean> {
  if (!isMacOS() || !existsSync(MACOS_SYSTEM_GIT)) return true;
  // The session already runs the system git: its version was checked by the caller
  if (currentGitPath && path.resolve(currentGitPath) === MACOS_SYSTEM_GIT) return true;
  if (macosSystemGitRelative === undefined) {
    try {
      const { stdout } = await runTool('git', ['--version'], {
        command: MACOS_SYSTEM_GIT,
        timeout: SYSTEM_GIT_TIMEOUT_MS,
      });
      macosSystemGitRelative = gitSupportsRelativeWorktrees(stdout.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null);
    } catch {
      macosSystemGitRelative = false;
    }
  }
  return macosSystemGitRelative;
}

/**
 * Whether new worktrees get relative links: only when every git that may open the repository is
 * 2.48+. Off Windows that is the git of this session, plus macOS's system git when it is another
 * binary. On Windows it is the git of this runtime and the other runtime's git, which has to be
 * known to be 2.48+ (or known to be missing); unknown means absolute links, which an older git
 * can still open.
 */
export async function useRelativeWorktreePaths(): Promise<boolean> {
  let current: { version: string | null; path: string | null };
  try {
    current = await currentGit();
  } catch {
    return false;
  }
  if (!gitSupportsRelativeWorktrees(current.version)) return false;
  if (!(await macosSystemGitSupportsRelative(current.path))) return false;
  if (!isWindows()) return true;
  const other = isWslRuntime() ? knownVersions.native : knownVersions.wsl;
  return other === null || gitSupportsRelativeWorktrees(other);
}

/** git arguments for a worktree command, with relative links when they are safe */
export async function worktreeGitArgs(args: string[]): Promise<string[]> {
  return (await useRelativeWorktreePaths()) ? [...RELATIVE_WORKTREES_CONFIG, ...args] : args;
}

// =============================================================================
// Repair
// =============================================================================

/** A linked worktree as the main repository records it (`.git/worktrees/<id>/gitdir`) */
export interface RecordedWorktree {
  /** The worktree folder (host path), null when the recorded path can't be read on this host */
  path: string | null;
  /** How the link is written */
  format: 'windows' | 'posix' | 'relative';
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * A worktree path as a key that two spellings of the same folder share, so a registered worktree
 * cannot look stale over the spelling alone - and a worktree that looks stale is deleted with the
 * uncommitted work in it. The Windows rule lives in `windowsPathKey` because the same mismatch
 * loses a project its spending and its memories (`belongsToProject`), and one rule in one place is
 * what keeps the two from drifting apart. Off Windows the path is only resolved, as paths there are
 * case-sensitive.
 */
export function worktreePathKey(worktreePath: string): string {
  const value = worktreePath.trim();
  return isWindows() ? windowsPathKey(value) : path.resolve(value);
}

/**
 * The worktree folder from a `gitdir` file's content (`<worktree>/.git`, as the git that wrote it
 * sees it): `C:/x/.git`, `/mnt/c/x/.git`, `/home/u/x/.git` or relative to `adminDir`.
 */
export function parseRecordedGitdir(content: string, adminDir: string, hints: WslPathHints = wslHints): RecordedWorktree {
  const value = content.trim();
  const strip = (p: string) => p.replace(/[\\/]\.git[\\/]?$/, '');
  // Windows git writes a path in the WSL home with forward slashes (`//wsl.localhost/<distro>/…`),
  // which would otherwise be read as a path inside the distribution
  if (DRIVE_PATH.test(value) || value.startsWith('\\\\') || isWslUncPath(value)) {
    return { path: path.win32.normalize(strip(value)), format: 'windows' };
  }
  if (value.startsWith('/')) {
    if (!isWindows()) return { path: strip(value), format: 'posix' };
    const info = getWslInfo();
    const distro = info?.distro ?? hints.distro;
    const mountRoot = info?.mountRoot ?? hints.mountRoot;
    const hostPath = wslToWindows(strip(value), { distro: distro ?? '', mountRoot });
    // A path inside the distribution needs its name
    return { path: !distro && hostPath.startsWith('\\\\') ? null : hostPath, format: 'posix' };
  }
  if (!value) return { path: null, format: 'relative' };
  return { path: strip(path.resolve(adminDir, value)), format: 'relative' };
}

/** Whether git of this session can't follow a link in this format */
function isForeignFormat(format: RecordedWorktree['format']): boolean {
  if (!isWindows() || format === 'relative') return false;
  return isWslRuntime() ? format === 'windows' : format === 'posix';
}

/** The linked worktrees the project's repository records, with existing folders */
export async function listRecordedWorktrees(projectPath: string): Promise<RecordedWorktree[]> {
  return (await listWorktreeRegistrations(projectPath)).filter((entry) => entry.onDisk).map(({ onDisk: _onDisk, id: _id, adminDir: _adminDir, ...entry }) => entry);
}

/** A registration under `.git/worktrees`, whether or not its folder is still there */
interface WorktreeRegistration extends RecordedWorktree {
  /** Name of its admin directory, which is how git refers to it */
  id: string;
  adminDir: string;
  /** Whether the folder the link names is still on disk */
  onDisk: boolean;
}

/**
 * Every worktree the project's repository records, classified by whether its folder is still there.
 *
 * Reading the admin directories rather than asking git is what lets a link the other runtime's git
 * cannot follow still be resolved: `parseRecordedGitdir` translates between the two namespaces,
 * where git only knows its own.
 */
async function listWorktreeRegistrations(projectPath: string): Promise<WorktreeRegistration[]> {
  const adminRoot = path.join(projectPath, '.git', 'worktrees');
  let ids: string[];
  try {
    ids = await fs.readdir(adminRoot);
  } catch {
    // No linked worktrees, or the project is itself a worktree / submodule (a .git file)
    return [];
  }
  const recorded: WorktreeRegistration[] = [];
  for (const id of ids) {
    const adminDir = path.join(adminRoot, id);
    try {
      const content = await fs.readFile(path.join(adminDir, 'gitdir'), 'utf-8');
      const entry = parseRecordedGitdir(content, adminDir);
      recorded.push({
        ...entry,
        id,
        adminDir,
        onDisk: !!entry.path && existsSync(path.join(entry.path, '.git')),
      });
    } catch {
      // Not a worktree entry
    }
  }
  return recorded;
}

export interface RepairResult {
  /** Worktrees handed to `git worktree repair` */
  repaired: string[];
  error?: string;
}

/**
 * Repair the links of the project's worktrees for the git of this session (Windows only): with
 * `all`, every recorded worktree (switching them to relative links when that is safe), otherwise
 * only the ones written by the other runtime's git. Never throws.
 */
export async function repairProjectWorktrees(projectPath: string, options: { all?: boolean; timeout?: number } = {}): Promise<RepairResult> {
  if (!isWindows()) return { repaired: [] };
  const recorded = await listRecordedWorktrees(projectPath);
  const targets = recorded
    .filter((entry) => options.all || isForeignFormat(entry.format))
    .map((entry) => entry.path as string);
  if (targets.length === 0) return { repaired: [] };
  try {
    await git(await worktreeGitArgs(['worktree', 'repair', ...targets]), {
      cwd: projectPath,
      isolated: true,
      timeout: options.timeout ?? 60_000,
    });
    return { repaired: targets };
  } catch (error) {
    const failure = error as { stderr?: unknown; message?: unknown };
    const detail = (typeof failure.stderr === 'string' && failure.stderr.trim()) || String(failure.message ?? error);
    return { repaired: targets, error: detail };
  }
}

/**
 * Before `git worktree prune` on Windows: repair worktrees whose links the other runtime's git
 * wrote, so the prune doesn't drop them as broken. No git call when there are none.
 */
export async function repairForeignWorktrees(projectPath: string): Promise<void> {
  const { error } = await repairProjectWorktrees(projectPath);
  if (error) appLog.warn(`[RuntimeWorktrees] Could not repair the worktrees of ${projectPath}: ${error}`);
}

/**
 * Drop the worktree registrations nothing can resolve any more, and only those.
 *
 * Pruning is how a worktree deleted outside the app stops blocking its task: without it the next
 * `worktree add` fails because the branch is still claimed by a registration nothing can reach.
 * The danger is the opposite case - a prune drops any registration whose link this git cannot
 * follow, and a link written by the other runtime's git is exactly that, so a worktree still on
 * disk would be unregistered and the caller that deletes the folder git no longer tracks would
 * take the task's uncommitted work with it.
 *
 * Which is which is decided per registration, not per project: `parseRecordedGitdir` resolves a
 * link in either runtime's namespace, so a folder that is still there is recognized as such
 * whatever wrote the link. When nothing is at risk, `git worktree prune` does the whole job. When
 * something is, the stale registrations are removed one at a time instead - leaving the project
 * unprunable because one *other* worktree has an unrepairable link would turn a state that heals
 * itself into a task that can never start again, and the reason would only be in the log.
 *
 * "Stale" means a link that resolved to a folder which is gone. A link that could not be resolved
 * at all is a different thing and is never removed: `parseRecordedGitdir` answers with no path when
 * it cannot translate the recorded gitdir - a WSL-written path while the distribution's name is not
 * known yet, which a task start can hit before the runtime check has filled the hints in - and the
 * folder behind such a link is very often right there on disk. Treating it as stale would
 * unregister a live worktree, and the caller that deletes the folder git no longer tracks would
 * take the task's uncommitted work with it, which is the one outcome this exists to prevent.
 *
 * Off Windows no link can be foreign, so this is the plain prune it has always been.
 */
export async function pruneWorktrees(projectPath: string): Promise<void> {
  const registrations = await listWorktreeRegistrations(projectPath);
  const unresolved = registrations.filter((entry) => !entry.path);
  const unfollowable = registrations.filter((entry) => entry.onDisk && isForeignFormat(entry.format));
  const atRisk = unresolved.length + unfollowable.length;

  if (atRisk === 0) {
    await git(await worktreeGitArgs(['worktree', 'prune']), { cwd: projectPath, isolated: true }).catch((error) => {
      appLog.warn(`[RuntimeWorktrees] Pruning ${projectPath} failed:`, error);
    });
    return;
  }

  // Only a link that resolved, to a folder that is not there
  const stale = registrations.filter((entry) => entry.path && !entry.onDisk);
  appLog.warn(
    `[RuntimeWorktrees] Not pruning ${projectPath} as a whole: ${atRisk} worktree(s) have a link this git cannot `
      + `follow or that could not be resolved at all, and a prune would unregister them so their folders are `
      + `deleted as untracked. Removing ${stale.length} registration(s) whose folder is really gone instead.`
  );
  for (const entry of stale) {
    try {
      // What `git worktree prune` does to such an entry, done only to the entries that deserve it
      await fs.rm(entry.adminDir, { recursive: true, force: true });
      appLog.info(`[RuntimeWorktrees] Removed the stale worktree registration ${entry.id} of ${projectPath}`);
    } catch (error) {
      appLog.warn(`[RuntimeWorktrees] Could not remove the stale worktree registration ${entry.id}:`, error);
    }
  }
}
