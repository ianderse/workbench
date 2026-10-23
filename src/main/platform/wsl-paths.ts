/**
 * Path translation between Windows and a WSL distribution (pure, no I/O).
 *
 * Windows drives live under the distribution's mount root (`/mnt/` unless /etc/wsl.conf changes
 * it), and the distribution's own files are reachable from Windows as
 * `\\wsl.localhost\<distro>\...` (or the older `\\wsl$\<distro>\...`).
 */

export interface WslPathOptions {
  /** The WSL distribution the paths belong to (e.g. "Ubuntu") */
  distro: string;
  /** Where Windows drives are mounted, `/mnt/` by default */
  mountRoot?: string;
}

const DEFAULT_MOUNT_ROOT = '/mnt/';

const DRIVE_PATH = /^([A-Za-z]):(?:[\\/](.*))?$/s;
const WSL_UNC_PATH = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/is;

/** Mount root with exactly one trailing slash ("/mnt" and "/mnt/" both give "/mnt/") */
export function normalizeMountRoot(mountRoot?: string): string {
  const root = (mountRoot || DEFAULT_MOUNT_ROOT).replace(/\/+$/, '');
  return `${root}/`;
}

/** Whether the path points into a WSL distribution (`\\wsl.localhost\...` or `\\wsl$\...`) */
export function isWslUncPath(p: string): boolean {
  return WSL_UNC_PATH.test(p);
}

/** Join path parts with "/" and drop a trailing slash (but keep "/" itself) */
function trimTrailingSlash(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Windows path -> path inside the distribution.
 * `C:\a\b` -> `/mnt/c/a/b`; `\\wsl.localhost\<distro>\x` -> `/x`. POSIX paths are returned
 * unchanged and relative paths get forward slashes. Returns null for a path the distribution
 * can't reach: another distribution's files or a network share.
 */
export function windowsToWsl(p: string, options: WslPathOptions): string | null {
  const drive = DRIVE_PATH.exec(p);
  if (drive) {
    const letter = drive[1].toLowerCase();
    const rest = (drive[2] ?? '').replace(/\\/g, '/');
    return trimTrailingSlash(`${normalizeMountRoot(options.mountRoot)}${letter}/${rest}`);
  }

  const unc = WSL_UNC_PATH.exec(p);
  if (unc) {
    if (unc[1].toLowerCase() !== options.distro.toLowerCase()) return null;
    return trimTrailingSlash(`/${(unc[2] ?? '').replace(/\\/g, '/')}`);
  }

  // Any other UNC path (\\server\share) is not reachable from inside WSL
  if (/^[\\/]{2}/.test(p) && p.includes('\\')) return null;

  if (p.startsWith('/')) return p;
  return p.replace(/\\/g, '/');
}

/**
 * Path inside the distribution -> Windows path.
 * `/mnt/c/x` -> `C:\x`; any other absolute path -> `\\wsl.localhost\<distro>\x`. Relative paths
 * get backslashes.
 */
export function wslToWindows(p: string, options: WslPathOptions): string {
  if (!p.startsWith('/')) return p.replace(/\//g, '\\');

  const mountRoot = normalizeMountRoot(options.mountRoot);
  if (p.startsWith(mountRoot)) {
    const match = /^([A-Za-z])(?:\/(.*))?$/s.exec(p.slice(mountRoot.length));
    if (match) {
      const rest = (match[2] ?? '').replace(/\/+$/, '').replace(/\//g, '\\');
      return `${match[1].toUpperCase()}:\\${rest}`;
    }
  }

  const rest = trimTrailingSlash(p) === '/' ? '' : trimTrailingSlash(p).replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${options.distro}${rest}`;
}
