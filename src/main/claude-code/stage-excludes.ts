/**
 * Generated folders a task must never commit
 * ==========================================
 *
 * A project without a .gitignore lets `git add -A` stage `node_modules`, `.venv`, build output and
 * the like. The pathspecs here keep them out of the commits Workbench makes itself.
 *
 * `:(exclude,glob)**\/name/**` matches the folder at the root and nested in any package;
 * ambiguous build-output names are matched at the root only (`:(exclude,top,glob)name/**`). Excludes
 * only limit what `git add` picks up: a file the project already tracks inside such a folder is
 * never un-tracked by them, which is why `stageTaskWork` stages tracked changes separately with
 * `git add -u` (without these excludes).
 */

import { git, type GitOptions } from '../utils/git-exec';

/** Folders that only ever hold dependencies or caches: excluded at any depth */
export const GENERATED_DIRS: readonly string[] = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
];

/**
 * Build output names that are also used for real source folders deeper in a tree (`src/build/`,
 * `packages/x/out/`), so they are only excluded at the project root
 */
export const ROOT_GENERATED_DIRS: readonly string[] = ['dist', 'build', 'out', 'target', 'coverage'];

/** Lockfiles: left out of review diffs shown to a model (they are still committed) */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
];

/** Git pathspecs excluding the generated folders (anywhere in the tree) plus extra exact paths */
export function buildStageExcludes(extraPaths: readonly string[] = []): string[] {
  return [
    ...extraPaths.map((p) => `:(exclude)${p}`),
    ...GENERATED_DIRS.map((dir) => `:(exclude,glob)**/${dir}/**`),
    ...ROOT_GENERATED_DIRS.map((dir) => `:(exclude,top,glob)${dir}/**`),
  ];
}

/** Pathspecs for review diffs: generated folders and lockfiles left out */
export function buildReviewExcludes(extraPaths: readonly string[] = []): string[] {
  return [
    ...buildStageExcludes(extraPaths),
    ...LOCKFILE_NAMES.map((name) => `:(exclude,glob)**/${name}`),
  ];
}

/**
 * Stage a task's work: changes to tracked files (anywhere, also inside generated folders the
 * project deliberately committed) and new files outside the generated folders.
 * Returns whether anything is staged.
 */
export async function stageTaskWork(
  cwd: string,
  extraExcludePaths: readonly string[] = [],
  gitOptions: Omit<GitOptions, 'cwd'> = {},
): Promise<boolean> {
  const own = extraExcludePaths.map((p) => `:(exclude)${p}`);
  await git(['add', '-u', '--', '.', ...own], { ...gitOptions, cwd });
  await git(['add', '--', '.', ...buildStageExcludes(extraExcludePaths)], { ...gitOptions, cwd });
  const { stdout } = await git(['diff', '--cached', '--name-only'], { ...gitOptions, cwd });
  return stdout.trim().length > 0;
}
