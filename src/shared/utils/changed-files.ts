/**
 * Paths of files a task changed, as the changelog, notices, briefings and resync requests list
 * them. Agents' tools also name pseudo targets that are not files (`agent:/IntCli040`,
 * `conflict:/1`, `conflict:/*`); only real repo-relative paths are kept.
 */

/** `scheme:/...` (also `C:/`): not a path inside the worktree */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/;

/** The repo-relative path with forward slashes, or undefined when it is no real file path */
export function toRepoPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let file = value.trim().replace(/\\/g, '/');
  if (!file || CONTROL_CHARS.test(file) || SCHEME.test(file)) return undefined;
  file = file.replace(/^(\.\/)+/, '');
  if (!file || file.startsWith('/') || file === '.') return undefined;
  if (file.split('/').some((part) => part === '..' || part === '')) return undefined;
  // Glob or placeholder targets (`*`, `?`) are never an edited file
  if (/[*?]/.test(file)) return undefined;
  return file;
}

/** Keep only real repo-relative paths (deduplicated, order kept) */
export function sanitizeChangedFiles(files: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const value of files ?? []) {
    const file = toRepoPath(value);
    if (file && !out.includes(file)) out.push(file);
  }
  return out;
}
