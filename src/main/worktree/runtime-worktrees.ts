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
 *   extension, and older git then refuses the whole repository.
 * - Links in the other runtime's format are repaired (`git worktree repair <paths>`) before a
 *   prune, and for every project when the app starts in a different runtime than last time.
 *
 * No electron imports: worktree creation imports this.
 */

import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { getToolInfoAsync } from '../cli-tool-manager';
import { isWindows } from '../platform';
import { getWslInfo, isWslRuntime } from '../platform/shell-runtime';
import { wslToWindows } from '../platform/wsl-paths';
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

/** Back to the startup state (tests) */
export function resetRuntimeWorktreesForTests(): void {
  knownVersions = {};
  wslHints = {};
}

/** The git version of the runtime this session runs its tools in */
async function currentGitVersion(): Promise<string | null> {
  const wsl = getWslInfo();
  if (wsl) return wsl.tools.git.path ? wsl.tools.git.version : null;
  const info = await getToolInfoAsync('git');
  return info.found ? info.version ?? null : null;
}

/**
 * Whether new worktrees get relative links. Off Windows: when git is 2.48+. On Windows: when the
 * git of this runtime is 2.48+ and the other runtime's git is known to be 2.48+ (or known to be
 * missing); unknown means absolute links, which an older git can still open.
 */
export async function useRelativeWorktreePaths(): Promise<boolean> {
  let current: string | null;
  try {
    current = await currentGitVersion();
  } catch {
    return false;
  }
  if (!gitSupportsRelativeWorktrees(current)) return false;
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
 * The worktree folder from a `gitdir` file's content (`<worktree>/.git`, as the git that wrote it
 * sees it): `C:/x/.git`, `/mnt/c/x/.git`, `/home/u/x/.git` or relative to `adminDir`.
 */
export function parseRecordedGitdir(content: string, adminDir: string, hints: WslPathHints = wslHints): RecordedWorktree {
  const value = content.trim();
  const strip = (p: string) => p.replace(/[\\/]\.git[\\/]?$/, '');
  if (DRIVE_PATH.test(value) || value.startsWith('\\\\')) {
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
  const adminRoot = path.join(projectPath, '.git', 'worktrees');
  let ids: string[];
  try {
    ids = await fs.readdir(adminRoot);
  } catch {
    // No linked worktrees, or the project is itself a worktree / submodule (a .git file)
    return [];
  }
  const recorded: RecordedWorktree[] = [];
  for (const id of ids) {
    const adminDir = path.join(adminRoot, id);
    try {
      const content = await fs.readFile(path.join(adminDir, 'gitdir'), 'utf-8');
      const entry = parseRecordedGitdir(content, adminDir);
      if (entry.path && existsSync(path.join(entry.path, '.git'))) recorded.push(entry);
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
  await repairProjectWorktrees(projectPath);
}
