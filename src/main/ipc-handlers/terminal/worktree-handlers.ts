import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants';
import type {
  IPCResult,
  CreateTerminalWorktreeRequest,
  TerminalWorktreeConfig,
  TerminalWorktreeResult,
  OtherWorktreeInfo,
} from '../../../shared/types';
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync, copyFileSync, cpSync, statSync, readlinkSync } from 'fs';
import { matchesExtensionGlob } from '../../utils/glob-markers';
import { debugLog, debugError } from '../../../shared/utils/debug-logger';
import { projectStore } from '../../project-store';
import { isWindows } from '../../platform';
import { runTool } from '../../platform/runtime-exec';
import { repairForeignWorktrees, worktreeGitArgs } from '../../worktree/runtime-worktrees';
import {
  getTerminalWorktreeDir,
  getTerminalWorktreePath,
  getTerminalWorktreeMetadataDir,
  getTerminalWorktreeMetadataPath,
} from '../../worktree-paths';
import { git } from '../../utils/git-exec';
import { isWslRuntime, toHostPath, toRuntimePath } from '../../platform/shell-runtime';
import { cleanupWorktree } from '../../utils/worktree-cleanup';
import { addToWorktree } from '../../live-agent/project-setup';

// Shared validation regex for worktree names - lowercase alphanumeric with dashes/underscores
// Must start and end with alphanumeric character
const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;

// Validation regex for git branch names - allows alphanumeric, dots, slashes, dashes, underscores
const GIT_BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

// Git worktree list porcelain output parsing constants
const GIT_PORCELAIN = {
  WORKTREE_PREFIX: 'worktree ',
  HEAD_PREFIX: 'HEAD ',
  BRANCH_PREFIX: 'branch ',
  DETACHED_LINE: 'detached',
  COMMIT_SHA_LENGTH: 8,
} as const;

/**
 * Check if an error was caused by a timeout (execFileAsync with timeout sets killed=true).
 * This helper centralizes the timeout detection logic to avoid duplication.
 */
function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'killed' in error &&
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
  );
}

/**
 * Check if a path is a symlink or Windows junction (including broken ones).
 * Uses readlinkSync which works for both symlinks and junctions on all platforms.
 */
function isSymlinkOrJunction(targetPath: string): boolean {
  try {
    // readlinkSync throws if the path is not a symlink/junction
    // It works for both symlinks and junctions on Windows and Unix
    readlinkSync(targetPath);
    return true;
  } catch {
    return false; // Path doesn't exist or is not a symlink/junction
  }
}

/**
 * Fix repositories that are incorrectly marked with core.bare=true.
 * This can happen when git worktree operations incorrectly set bare=true
 * on a working repository that has source files.
 *
 * Returns true if a fix was applied, false otherwise.
 */
async function fixMisconfiguredBareRepo(projectPath: string): Promise<boolean> {
  try {
    // Check if bare=true is set
    const bareConfig = (await git(
      ['config', '--get', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8', isolated: true }
    )).stdout.trim().toLowerCase();

    if (bareConfig !== 'true') {
      return false; // Not marked as bare, nothing to fix
    }

    // Check if there are source files (indicating misconfiguration)
    // A truly bare repo would only have git internals, not source code
    // This covers multiple ecosystems: JS/TS, Python, Rust, Go, Java, C#, etc.
    const EXACT_MARKERS = [
      // JavaScript/TypeScript ecosystem
      'package.json', 'apps', 'src',
      // Python ecosystem
      'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile',
      // Rust ecosystem
      'Cargo.toml',
      // Go ecosystem
      'go.mod', 'go.sum', 'cmd', 'main.go',
      // Java/JVM ecosystem
      'pom.xml', 'build.gradle', 'build.gradle.kts',
      // Ruby ecosystem
      'Gemfile', 'Rakefile',
      // PHP ecosystem
      'composer.json',
      // General project markers
      'Makefile', 'CMakeLists.txt', 'README.md', 'LICENSE'
    ];

    const GLOB_MARKERS = [
      // .NET/C# ecosystem - patterns that need glob matching
      '*.csproj', '*.sln', '*.fsproj'
    ];

    // Check exact matches first (fast path)
    const hasExactMatch = EXACT_MARKERS.some(marker =>
      existsSync(path.join(projectPath, marker))
    );

    if (hasExactMatch) {
      // Found a project marker, proceed to fix
    } else {
      // Check glob patterns - read directory once and cache for all patterns
      let directoryFiles: string[] | null = null;
      const MAX_FILES_TO_CHECK = 500;

      const hasGlobMatch = GLOB_MARKERS.some(pattern => {
        // Validate pattern - only support simple glob patterns for security
        if (pattern.includes('..') || pattern.includes('/')) {
          debugLog('[TerminalWorktree] Unsupported glob pattern ignored:', pattern);
          return false;
        }

        // Lazy-load directory listing, cached across patterns
        if (directoryFiles === null) {
          try {
            const allFiles = readdirSync(projectPath);
            directoryFiles = allFiles.slice(0, MAX_FILES_TO_CHECK);
            if (allFiles.length > MAX_FILES_TO_CHECK) {
              debugLog(`[TerminalWorktree] Directory has ${allFiles.length} entries, checking only first ${MAX_FILES_TO_CHECK}`);
            }
          } catch (error) {
            debugError('[TerminalWorktree] Failed to read directory:', error);
            directoryFiles = [];
          }
        }

        return directoryFiles.some(file => matchesExtensionGlob(file, pattern));
      });

      if (!hasGlobMatch) {
        return false; // Legitimately bare repo
      }
    }

    // Fix the misconfiguration
    debugLog('[TerminalWorktree] Detected misconfigured bare repository with source files. Auto-fixing by unsetting core.bare...');
    await git(
      ['config', '--unset', 'core.bare'],
      { cwd: projectPath, encoding: 'utf-8', isolated: true }
    );
    debugLog('[TerminalWorktree] Fixed: core.bare has been unset. Git operations should now work correctly.');
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that projectPath is a registered project
 */
function isValidProjectPath(projectPath: string): boolean {
  const projects = projectStore.getProjects();
  return projects.some(p => p.path === projectPath);
}

// No limit on terminal worktrees - users can create as many as needed

/**
 * Get the default branch from project settings
 */
async function getDefaultBranch(projectPath: string): Promise<string> {
  const project = projectStore.getProjects().find(p => p.path === projectPath);
  if (project?.settings?.mainBranch) {
    debugLog('[TerminalWorktree] Using mainBranch from project settings:', project.settings.mainBranch);
    return project.settings.mainBranch;
  }

  for (const branch of ['main', 'master']) {
    try {
      await git(['rev-parse', '--verify', branch], {
        cwd: projectPath,
        encoding: 'utf-8',
        isolated: true,
      });
      debugLog('[TerminalWorktree] Auto-detected branch:', branch);
      return branch;
    } catch {
      // Branch doesn't exist, try next
    }
  }

  // Fallback to current branch - wrap in try-catch
  try {
    const currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8',
      isolated: true,
    })).stdout.trim();
    debugLog('[TerminalWorktree] Falling back to current branch:', currentBranch);
    return currentBranch;
  } catch (error) {
    debugError('[TerminalWorktree] Error detecting current branch:', error);
    return 'main'; // Safe default
  }
}

function shouldPushNewBranches(projectPath: string): boolean {
  const project = projectStore.getProjects().find(p => p.path === projectPath);
  return project?.settings?.pushNewBranches !== false;
}

/**
 * Configuration for a single dependency to be shared in a worktree.
 */
interface DependencyConfig {
  /** Dependency type identifier (e.g., 'node_modules', 'venv') */
  depType: string;
  /** Strategy for sharing this dependency in worktrees */
  strategy: 'symlink' | 'recreate' | 'copy' | 'skip';
  /** Relative path from project root to the dependency directory */
  sourceRelPath: string;
  /** Path to requirements file for recreate strategy (e.g., 'requirements.txt') */
  requirementsFile?: string;
  /** Package manager used (e.g., 'npm', 'pip', 'uv') */
  packageManager?: string;
}

/**
 * Dependencies shared into every worktree.
 */
const WORKTREE_DEPENDENCIES: DependencyConfig[] = [
  { depType: 'node_modules', strategy: 'symlink', sourceRelPath: 'node_modules' },
];

/**
 * Set up dependencies in a worktree using strategy-based dispatch.
 *
 * Applies the correct strategy for each: symlink, recreate, copy, or skip.
 *
 * All operations are non-blocking on failure — errors are logged but never thrown.
 *
 * @param projectPath - The main project directory
 * @param worktreePath - Path to the worktree
 * @returns Array of successfully processed dependency relative paths
 */
async function setupWorktreeDependencies(projectPath: string, worktreePath: string): Promise<string[]> {
  const configs = WORKTREE_DEPENDENCIES;
  const processed: string[] = [];

  for (const config of configs) {
    try {
      let performed = false;
      switch (config.strategy) {
        case 'symlink':
          performed = applySymlinkStrategy(projectPath, worktreePath, config);
          // For venvs, verify the symlink is usable — fall back to recreate if not
          // Run health check whenever a venv exists (not just on fresh creation)
          if (config.depType === 'venv' || config.depType === '.venv') {
            const venvPath = path.join(worktreePath, config.sourceRelPath);
            // Check if venv path exists (as symlink or otherwise)
            if (existsSync(venvPath) || isSymlinkOrJunction(venvPath)) {
              try {
                await runVenvTool(venvExecutable(venvPath, 'python'), ['-c', 'import sys; print(sys.prefix)'], {
                  timeout: 10000,
                });
                debugLog('[TerminalWorktree] Symlinked venv health check passed:', config.sourceRelPath);
              } catch {
                debugLog('[TerminalWorktree] Symlinked venv health check failed, falling back to recreate:', config.sourceRelPath);
                debugLog('[TerminalWorktree] Venv fallback: removing broken symlink and recreating for', config.sourceRelPath);
                // Remove the broken symlink and recreate
                try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
                performed = await applyRecreateStrategy(projectPath, worktreePath, config);
                if (performed) {
                  debugLog('[TerminalWorktree] Venv fallback to recreate succeeded:', config.sourceRelPath);
                }
              }
            }
          }
          break;
        case 'recreate':
          performed = await applyRecreateStrategy(projectPath, worktreePath, config);
          break;
        case 'copy':
          performed = applyCopyStrategy(projectPath, worktreePath, config);
          break;
        case 'skip':
          debugLog('[TerminalWorktree] Skipping', config.depType, `(${config.sourceRelPath}) - skip strategy`);
          continue; // Don't record skipped entries in processed list
      }
      if (performed) processed.push(config.sourceRelPath);
    } catch (error) {
      debugError('[TerminalWorktree] Failed to apply', config.strategy, 'strategy for', config.sourceRelPath, ':', error);
      console.warn(`[TerminalWorktree] Warning: Failed to set up ${config.sourceRelPath}`);
    }
  }

  return processed;
}

/**
 * Apply symlink strategy: create a symlink (or Windows junction) from worktree to project source.
 * Reuses the existing platform-specific symlink creation pattern.
 */
function applySymlinkStrategy(projectPath: string, worktreePath: string, config: DependencyConfig): boolean {
  const sourcePath = path.join(projectPath, config.sourceRelPath);
  const targetPath = path.join(worktreePath, config.sourceRelPath);

  if (!existsSync(sourcePath)) {
    debugLog('[TerminalWorktree] Skipping symlink', config.sourceRelPath, '- source missing');
    return false;
  }

  if (existsSync(targetPath)) {
    debugLog('[TerminalWorktree] Skipping symlink', config.sourceRelPath, '- target exists');
    return false;
  }

  // Check for broken symlinks and remove them so a fresh symlink can be created
  if (isSymlinkOrJunction(targetPath)) {
    if (!existsSync(targetPath)) {
      debugLog('[TerminalWorktree] Removing broken symlink for', config.sourceRelPath);
      try { rmSync(targetPath, { force: true }); } catch { /* best-effort */ }
    } else {
      debugLog('[TerminalWorktree] Skipping symlink', config.sourceRelPath, '- target exists (symlink)');
      return false;
    }
  }

  const targetDir = path.dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    if (isWindows()) {
      symlinkSync(sourcePath, targetPath, 'junction');
      debugLog('[TerminalWorktree] Created junction (Windows):', config.sourceRelPath, '->', sourcePath);
    } else {
      const relativePath = path.relative(path.dirname(targetPath), sourcePath);
      symlinkSync(relativePath, targetPath);
      debugLog('[TerminalWorktree] Created symlink (Unix):', config.sourceRelPath, '->', relativePath);
    }
    return true;
  } catch (error) {
    debugError('[TerminalWorktree] Could not create symlink for', config.sourceRelPath, ':', error);
    console.warn(`[TerminalWorktree] Warning: Failed to link ${config.sourceRelPath}`);
    return false;
  }
}

/**
 * Whether venvs follow the Windows layout (`Scripts\python.exe`) rather than the POSIX one
 * (`bin/python`): the layout of the OS the tools run on, so Linux venvs in WSL
 */
export function usesWindowsVenvLayout(): boolean {
  return isWindows() && !isWslRuntime();
}

/** A venv's python or pip (host path) for the OS the tools run on */
export function venvExecutable(venvPath: string, name: 'python' | 'pip'): string {
  return usesWindowsVenvLayout()
    ? path.join(venvPath, 'Scripts', `${name}.exe`)
    : path.join(venvPath, 'bin', name);
}

/**
 * Run a venv executable (or the detected Python when none is given) through the runtime layer:
 * in WSL the venv's Linux executable runs inside the distribution, path arguments translated
 */
function runVenvTool(executable: string | undefined, args: string[], options: { timeout: number }) {
  return runTool('python', args, {
    ...options,
    encoding: 'utf-8',
    ...(executable ? { command: isWslRuntime() ? toRuntimePath(executable) : executable } : {}),
  });
}

/** Marker file written inside a recreated venv to indicate setup completed successfully. */
const VENV_SETUP_COMPLETE_MARKER = '.setup_complete';

/**
 * Apply recreate strategy: create a fresh virtual environment in the worktree.
 *
 * Used as a fallback when venv symlinking fails (CPython bug #106045).
 * Writes a completion marker so incomplete venvs can be detected and rebuilt.
 */
async function applyRecreateStrategy(projectPath: string, worktreePath: string, config: DependencyConfig): Promise<boolean> {
  const venvPath = path.join(worktreePath, config.sourceRelPath);
  const markerPath = path.join(venvPath, VENV_SETUP_COMPLETE_MARKER);

  // Check for broken symlinks that existsSync would miss
  if (isSymlinkOrJunction(venvPath) && !existsSync(venvPath)) {
    debugLog('[TerminalWorktree] Removing broken symlink at', config.sourceRelPath);
    try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  } else if (existsSync(venvPath)) {
    if (existsSync(markerPath)) {
      debugLog('[TerminalWorktree] Skipping recreate', config.sourceRelPath, '- already complete (marker present)');
      return false;
    }
    // Venv exists but marker is missing — incomplete, remove and rebuild
    debugLog('[TerminalWorktree] Removing incomplete venv', config.sourceRelPath, '(no marker)');
    try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Python from the source venv (when it was made for the OS the tools run on) or the detected Python
  const sourceVenv = path.join(projectPath, config.sourceRelPath);
  const sourcePython = venvExecutable(sourceVenv, 'python');
  const pythonExec = existsSync(sourcePython) ? sourcePython : undefined;

  // Create the venv
  try {
    debugLog('[TerminalWorktree] Creating venv at', config.sourceRelPath);
    await runVenvTool(pythonExec, ['-m', 'venv', venvPath], {
      timeout: 120000,
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      debugError('[TerminalWorktree] venv creation timed out for', config.sourceRelPath);
      console.warn(`[TerminalWorktree] Warning: venv creation timed out for ${config.sourceRelPath}`);
    } else {
      debugError('[TerminalWorktree] venv creation failed for', config.sourceRelPath, ':', error);
      console.warn(`[TerminalWorktree] Warning: Could not create venv at ${config.sourceRelPath}`);
    }
    // Clean up partial venv so retries aren't blocked
    if (existsSync(venvPath)) {
      try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    return false;
  }

  // Install from requirements file if specified
  if (config.requirementsFile) {
    const reqPath = path.join(projectPath, config.requirementsFile);
    if (existsSync(reqPath)) {
      const pipExec = venvExecutable(venvPath, 'pip');

      // Build install command based on file type
      const reqBasename = path.basename(config.requirementsFile);
      let installArgs: string[] | null;
      if (reqBasename === 'pyproject.toml') {
        // Snapshot-install from worktree copy (non-editable to avoid
        // symlinking back to the main project source tree).
        const worktreeReq = path.join(worktreePath, config.requirementsFile!);
        const installDir = existsSync(worktreeReq) ? path.dirname(worktreeReq) : path.dirname(reqPath);
        installArgs = ['install', installDir];
      } else if (reqBasename === 'Pipfile') {
        debugLog('[TerminalWorktree] Skipping Pipfile-based install (use pipenv in worktree)');
        installArgs = null;
      } else {
        installArgs = ['install', '-r', reqPath];
      }

      if (installArgs) {
        try {
          debugLog('[TerminalWorktree] Installing deps from', config.requirementsFile);
          await runVenvTool(pipExec, installArgs, {
            timeout: 300000,
          });
        } catch (error) {
          if (isTimeoutError(error)) {
            debugError('[TerminalWorktree] pip install timed out for', config.requirementsFile);
            console.warn(`[TerminalWorktree] Warning: Dependency install timed out for ${config.requirementsFile}`);
          } else {
            debugError('[TerminalWorktree] pip install failed:', error);
          }
          // Clean up broken venv so retries aren't blocked
          if (existsSync(venvPath)) {
            try { rmSync(venvPath, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
          return false;
        }
      }
    }
  }

  // Write completion marker so future runs know this venv is complete
  try {
    writeFileSync(markerPath, '');
  } catch (error) {
    debugLog('[TerminalWorktree] Failed to write completion marker at', markerPath, ':', error);
  }

  debugLog('[TerminalWorktree] Recreated venv at', config.sourceRelPath);
  return true;
}

/**
 * Apply copy strategy: copy a file or directory from project to worktree.
 */
function applyCopyStrategy(projectPath: string, worktreePath: string, config: DependencyConfig): boolean {
  const sourcePath = path.join(projectPath, config.sourceRelPath);
  const targetPath = path.join(worktreePath, config.sourceRelPath);

  if (!existsSync(sourcePath)) {
    debugLog('[TerminalWorktree] Skipping copy', config.sourceRelPath, '- source missing');
    return false;
  }

  if (existsSync(targetPath)) {
    debugLog('[TerminalWorktree] Skipping copy', config.sourceRelPath, '- target exists');
    return false;
  }

  const targetDir = path.dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    if (statSync(sourcePath).isDirectory()) {
      cpSync(sourcePath, targetPath, { recursive: true });
    } else {
      copyFileSync(sourcePath, targetPath);
    }
    debugLog('[TerminalWorktree] Copied', config.sourceRelPath, 'to worktree');
    return true;
  } catch (error) {
    debugError('[TerminalWorktree] Could not copy', config.sourceRelPath, ':', error);
    console.warn(`[TerminalWorktree] Warning: Could not copy ${config.sourceRelPath}`);
    return false;
  }
}

/**
 * Symlink the project root's .claude/ directory into a terminal worktree.
 * This enables Claude Code features (settings, commands, memory) in worktree terminals.
 * Follows the same pattern as setupWorktreeDependencies().
 */
function symlinkClaudeConfigToWorktree(projectPath: string, worktreePath: string): string[] {
  const symlinked: string[] = [];

  const sourceRel = '.claude';
  const sourcePath = path.join(projectPath, sourceRel);
  const targetPath = path.join(worktreePath, sourceRel);

  // Skip if source doesn't exist
  if (!existsSync(sourcePath)) {
    debugLog('[TerminalWorktree] Skipping .claude symlink - source does not exist:', sourcePath);
    return symlinked;
  }

  // Skip if target already exists
  if (existsSync(targetPath)) {
    debugLog('[TerminalWorktree] Skipping .claude symlink - target already exists:', targetPath);
    return symlinked;
  }

  // Also skip if target is a symlink (even if broken)
  try {
    lstatSync(targetPath);
    debugLog('[TerminalWorktree] Skipping .claude symlink - target exists (possibly broken symlink):', targetPath);
    return symlinked;
  } catch {
    // Target doesn't exist at all - good, we can create symlink
  }

  // Ensure parent directory exists
  const targetDir = path.dirname(targetPath);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  try {
    if (isWindows()) {
      symlinkSync(sourcePath, targetPath, 'junction');
      debugLog('[TerminalWorktree] Created .claude junction (Windows):', sourceRel, '->', sourcePath);
    } else {
      const relativePath = path.relative(path.dirname(targetPath), sourcePath);
      symlinkSync(relativePath, targetPath);
      debugLog('[TerminalWorktree] Created .claude symlink (Unix):', sourceRel, '->', relativePath);
    }
    symlinked.push(sourceRel);
  } catch (error) {
    debugError('[TerminalWorktree] Could not create symlink for .claude:', error);
  }

  return symlinked;
}

function saveWorktreeConfig(projectPath: string, name: string, config: TerminalWorktreeConfig): void {
  const metadataDir = getTerminalWorktreeMetadataDir(projectPath);
  mkdirSync(metadataDir, { recursive: true });
  const metadataPath = getTerminalWorktreeMetadataPath(projectPath, name);
  writeFileSync(metadataPath, JSON.stringify(config, null, 2), 'utf-8');
}

function loadWorktreeConfig(projectPath: string, name: string): TerminalWorktreeConfig | null {
  // Check new metadata location first
  const metadataPath = getTerminalWorktreeMetadataPath(projectPath, name);
  if (existsSync(metadataPath)) {
    try {
      return JSON.parse(readFileSync(metadataPath, 'utf-8'));
    } catch (error) {
      debugError('[TerminalWorktree] Corrupted config at:', metadataPath, error);
      return null;
    }
  }

  // Backwards compatibility: check legacy location inside worktree
  const legacyConfigPath = path.join(getTerminalWorktreePath(projectPath, name), 'config.json');
  if (existsSync(legacyConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(legacyConfigPath, 'utf-8'));
      // Migrate to new location
      saveWorktreeConfig(projectPath, name, config);
      // Clean up legacy file
      try {
        rmSync(legacyConfigPath);
        debugLog('[TerminalWorktree] Migrated config from legacy location:', name);
      } catch {
        debugLog('[TerminalWorktree] Could not remove legacy config:', legacyConfigPath);
      }
      return config;
    } catch (error) {
      debugError('[TerminalWorktree] Corrupted legacy config at:', legacyConfigPath, error);
      return null;
    }
  }

  return null;
}

async function createTerminalWorktree(
  request: CreateTerminalWorktreeRequest
): Promise<TerminalWorktreeResult> {
  const { terminalId, name, taskId, createGitBranch, projectPath, baseBranch: customBaseBranch, useLocalBranch } = request;

  debugLog('[TerminalWorktree] Creating worktree:', { name, taskId, createGitBranch, projectPath, customBaseBranch, useLocalBranch });

  // Validate projectPath against registered projects
  if (!isValidProjectPath(projectPath)) {
    return {
      success: false,
      error: 'Invalid project path',
    };
  }

  // Validate worktree name - use shared regex (lowercase only)
  if (!WORKTREE_NAME_REGEX.test(name)) {
    return {
      success: false,
      error: 'Invalid worktree name. Use lowercase letters, numbers, dashes, and underscores. Must start and end with alphanumeric.',
    };
  }

  // CRITICAL: Validate customBaseBranch to prevent command injection
  if (customBaseBranch && !GIT_BRANCH_REGEX.test(customBaseBranch)) {
    return {
      success: false,
      error: 'Invalid base branch name',
    };
  }

  // Auto-fix any misconfigured bare repo before worktree operations
  // This prevents crashes when git worktree operations have incorrectly set bare=true
  if (await fixMisconfiguredBareRepo(projectPath)) {
    debugLog('[TerminalWorktree] Fixed misconfigured bare repository at:', projectPath);
  }

  const worktreePath = getTerminalWorktreePath(projectPath, name);
  const branchName = `terminal/${name}`;
  let directoryCreated = false;

  try {
    if (existsSync(worktreePath)) {
      return { success: false, error: `Worktree '${name}' already exists.` };
    }

    mkdirSync(getTerminalWorktreeDir(projectPath), { recursive: true });
    directoryCreated = true;

    // Use custom base branch if provided, otherwise detect default
    const baseBranch = customBaseBranch || await getDefaultBranch(projectPath);
    debugLog('[TerminalWorktree] Using base branch:', baseBranch, customBaseBranch ? '(custom)' : '(default)');

    // Check if baseBranch is already a remote ref (e.g., "origin/feature-x")
    const isRemoteRef = baseBranch.startsWith('origin/');
    const remoteBranchName = isRemoteRef ? baseBranch.replace('origin/', '') : baseBranch;

    // Fetch the branch from remote (async to avoid blocking main process)
    try {
      await git(['fetch', 'origin', remoteBranchName], {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 30000,
        isolated: true,
      });
      debugLog('[TerminalWorktree] Fetched latest from origin/' + remoteBranchName);
    } catch {
      debugLog('[TerminalWorktree] Could not fetch from remote, continuing with local branch');
    }

    // Determine the base ref to use for worktree creation
    let baseRef = baseBranch;
    if (isRemoteRef) {
      // Already a remote ref, use as-is
      baseRef = baseBranch;
      debugLog('[TerminalWorktree] Using remote ref directly:', baseRef);
    } else if (useLocalBranch) {
      // User explicitly requested local branch - skip auto-switch to remote
      // This preserves gitignored files (.env, configs) that may not exist on remote
      baseRef = baseBranch;
      debugLog('[TerminalWorktree] Using local branch (explicit):', baseRef);
    } else {
      // Default behavior: check if remote version exists and use it for latest code
      try {
        await git(['rev-parse', '--verify', `origin/${baseBranch}`], {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 10000,
          isolated: true,
        });
        baseRef = `origin/${baseBranch}`;
        debugLog('[TerminalWorktree] Using remote ref:', baseRef);
      } catch {
        debugLog('[TerminalWorktree] Remote ref not found, using local branch:', baseBranch);
      }
    }

    let remoteTrackingSetUp = false;
    let remotePushWarning: string | undefined;

    if (createGitBranch) {
      // Use --no-track to prevent the new branch from inheriting upstream tracking
      // from the base ref (e.g., origin/main). This ensures users can push with -u
      // to correctly set up tracking to their own remote branch.
      // Use async to avoid blocking the main process on large repos.
      await git(await worktreeGitArgs(['worktree', 'add', '-b', branchName, '--no-track', worktreePath, baseRef]), {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 60000,
        isolated: true,
      });
      debugLog('[TerminalWorktree] Created worktree with branch:', branchName, 'from', baseRef);

      // Push the new branch to remote and set up tracking so subsequent
      // git push/pull operations work correctly from the worktree.
      // This prevents branches from accumulating local-only commits with
      // no upstream configured, which causes confusion when pushing later.
      // Check if 'origin' remote exists — silently skip for local-only repos
      let hasOrigin = false;
      try {
        await git(['remote', 'get-url', 'origin'], {
          cwd: projectPath,
          encoding: 'utf-8',
          timeout: 5000,
          isolated: true,
        });
        hasOrigin = true;
      } catch {
        // No origin remote — local-only repo, nothing to push to
        debugLog('[TerminalWorktree] No origin remote found, skipping push for local-only repo');
      }

      if (hasOrigin && shouldPushNewBranches(projectPath)) {
        try {
          await git(['push', '-u', 'origin', branchName], {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 30000,
            isolated: true,
          });
          remoteTrackingSetUp = true;
          debugLog('[TerminalWorktree] Pushed branch to remote with tracking:', branchName);
        } catch (pushError) {
          // Worktree was created successfully — don't fail the operation,
          // but surface a warning so the user knows tracking isn't set up.
          const message = pushError instanceof Error ? pushError.message : 'Unknown push error';
          remotePushWarning = message;
          debugLog('[TerminalWorktree] Could not push to remote (worktree still usable):', message);
        }
      } else if (!shouldPushNewBranches(projectPath)) {
        debugLog('[TerminalWorktree] Leaving branch local-only (auto-push disabled):', branchName);
      }
    } else {
      // Use async to avoid blocking the main process on large repos.
      await git(await worktreeGitArgs(['worktree', 'add', '--detach', worktreePath, baseRef]), {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 60000,
        isolated: true,
      });
      debugLog('[TerminalWorktree] Created worktree in detached HEAD mode from', baseRef);
    }

    // Set up dependencies (node_modules, venvs, etc.) for tooling support
    // This allows pre-commit hooks to run typecheck without npm install in worktree
    const setupDeps = await setupWorktreeDependencies(projectPath, worktreePath);
    if (setupDeps.length > 0) {
      debugLog('[TerminalWorktree] Set up worktree dependencies:', setupDeps.join(', '));
    }

    // Symlink .claude/ config for Claude Code features (settings, commands, memory)
    const symlinkedClaude = symlinkClaudeConfigToWorktree(projectPath, worktreePath);
    if (symlinkedClaude.length > 0) {
      debugLog('[TerminalWorktree] Symlinked Claude config:', symlinkedClaude.join(', '));
    }

    // Live agent: the project's Claude Code hooks (a copy of its settings.local.json, unless
    // .claude was just symlinked)
    try {
      addToWorktree(projectPath, worktreePath);
    } catch (error) {
      debugError('[TerminalWorktree] Could not copy the Live agent hooks:', error);
    }

    const config: TerminalWorktreeConfig = {
      name,
      worktreePath,
      branchName: createGitBranch ? branchName : '',
      baseBranch,
      hasGitBranch: createGitBranch,
      taskId,
      createdAt: new Date().toISOString(),
      terminalId,
      remoteTrackingSetUp,
    };

    saveWorktreeConfig(projectPath, name, config);
    debugLog('[TerminalWorktree] Saved config for worktree:', name);

    return { success: true, config, warning: remotePushWarning };
  } catch (error) {
    debugError('[TerminalWorktree] Error creating worktree:', error);

    // Cleanup: remove the worktree directory if git worktree creation failed
    if (directoryCreated && existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        debugLog('[TerminalWorktree] Cleaned up failed worktree directory:', worktreePath);
        // Also prune stale worktree registrations in case git worktree add partially succeeded
        try {
          await repairForeignWorktrees(projectPath);
          await git(['worktree', 'prune'], {
            cwd: projectPath,
            encoding: 'utf-8',
            isolated: true,
          });
          debugLog('[TerminalWorktree] Pruned stale worktree registrations');
        } catch {
          // Ignore prune errors - not critical
        }
      } catch (cleanupError) {
        debugError('[TerminalWorktree] Failed to cleanup worktree directory:', cleanupError);
      }
    }

    // Check if error was due to timeout
    const isTimeout = isTimeoutError(error);

    return {
      success: false,
      error: isTimeout
        ? 'Git operation timed out. The repository may be too large or the network connection is slow. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Failed to create worktree',
    };
  }
}

async function listTerminalWorktrees(projectPath: string): Promise<TerminalWorktreeConfig[]> {
  // Validate projectPath against registered projects
  if (!isValidProjectPath(projectPath)) {
    debugError('[TerminalWorktree] Invalid project path for listing:', projectPath);
    return [];
  }

  const configs: TerminalWorktreeConfig[] = [];
  const seenNames = new Set<string>();
  const staleMetadataFiles: string[] = [];

  // Scan new metadata directory
  const metadataDir = getTerminalWorktreeMetadataDir(projectPath);
  if (existsSync(metadataDir)) {
    try {
      for (const file of readdirSync(metadataDir, { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.json')) {
          const name = file.name.replace('.json', '');
          const config = loadWorktreeConfig(projectPath, name);
          if (config) {
            // Verify worktree directory still exists
            if (existsSync(config.worktreePath)) {
              configs.push(config);
              seenNames.add(name);
            } else {
              // Mark stale metadata for cleanup
              staleMetadataFiles.push(path.join(metadataDir, file.name));
              debugLog('[TerminalWorktree] Found stale metadata for deleted worktree:', name);
            }
          }
        }
      }
    } catch (error) {
      debugError('[TerminalWorktree] Error scanning metadata dir:', error);
    }
  }

  // Also scan worktree directory for legacy configs (will be migrated on load)
  const worktreeDir = getTerminalWorktreeDir(projectPath);
  if (existsSync(worktreeDir)) {
    try {
      for (const dir of readdirSync(worktreeDir, { withFileTypes: true })) {
        if (dir.isDirectory() && !seenNames.has(dir.name)) {
          const config = loadWorktreeConfig(projectPath, dir.name);
          if (config) {
            configs.push(config);
          }
        }
      }
    } catch (error) {
      debugError('[TerminalWorktree] Error scanning worktree dir:', error);
    }
  }

  // Auto-cleanup stale metadata files (best-effort cleanup before returning)
  if (staleMetadataFiles.length > 0) {
    for (const filePath of staleMetadataFiles) {
      try {
        rmSync(filePath);
        debugLog('[TerminalWorktree] Cleaned up stale metadata file:', filePath);
      } catch (error) {
        debugError('[TerminalWorktree] Failed to cleanup stale metadata:', filePath, error);
      }
    }
  }

  return configs;
}

/**
 * List "other" worktrees - worktrees not managed by Workbench
 * These are discovered via `git worktree list` excluding:
 * - Main worktree (project root)
 * - .workbench/worktrees/terminal/*
 * - .workbench/worktrees/tasks/*
 * - .workbench/worktrees/pr/*
 */
export async function listOtherWorktrees(projectPath: string): Promise<OtherWorktreeInfo[]> {
  // Validate projectPath against registered projects
  if (!isValidProjectPath(projectPath)) {
    debugError('[TerminalWorktree] Invalid project path for listing other worktrees:', projectPath);
    return [];
  }

  const results: OtherWorktreeInfo[] = [];

  // Paths to exclude (normalize for comparison)
  const normalizedProjectPath = path.resolve(projectPath);
  const excludePrefixes = [
    path.join(normalizedProjectPath, '.workbench', 'worktrees', 'terminal'),
    path.join(normalizedProjectPath, '.workbench', 'worktrees', 'tasks'),
    path.join(normalizedProjectPath, '.workbench', 'worktrees', 'pr'),
  ];

  try {
    const { stdout: output } = await git(['worktree', 'list', '--porcelain'], {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 30000,
      isolated: true,
    });

    // Parse porcelain output
    // Format:
    // worktree /path/to/worktree
    // HEAD abc123...
    // branch refs/heads/branch-name (or "detached" line)
    // (blank line)

    let currentWorktree: { path?: string; head?: string; branch?: string | null } = {};

    for (const line of output.split('\n')) {
      if (line.startsWith(GIT_PORCELAIN.WORKTREE_PREFIX)) {
        // Save previous worktree if complete
        if (currentWorktree.path && currentWorktree.head) {
          processOtherWorktree(currentWorktree, normalizedProjectPath, excludePrefixes, results);
        }
        // git in WSL lists Linux paths
        currentWorktree = { path: toHostPath(line.substring(GIT_PORCELAIN.WORKTREE_PREFIX.length)) };
      } else if (line.startsWith(GIT_PORCELAIN.HEAD_PREFIX)) {
        currentWorktree.head = line.substring(GIT_PORCELAIN.HEAD_PREFIX.length);
      } else if (line.startsWith(GIT_PORCELAIN.BRANCH_PREFIX)) {
        // Extract branch name from "refs/heads/branch-name"
        const fullRef = line.substring(GIT_PORCELAIN.BRANCH_PREFIX.length);
        currentWorktree.branch = fullRef.replace('refs/heads/', '');
      } else if (line === GIT_PORCELAIN.DETACHED_LINE) {
        currentWorktree.branch = null; // Use null for detached HEAD state
      }
    }

    // Process final worktree
    if (currentWorktree.path && currentWorktree.head) {
      processOtherWorktree(currentWorktree, normalizedProjectPath, excludePrefixes, results);
    }
  } catch (error) {
    debugError('[TerminalWorktree] Error listing other worktrees:', error);
  }

  return results;
}

function processOtherWorktree(
  wt: { path?: string; head?: string; branch?: string | null },
  mainWorktreePath: string,
  excludePrefixes: string[],
  results: OtherWorktreeInfo[]
): void {
  if (!wt.path || !wt.head) return;

  const normalizedPath = path.resolve(wt.path);

  // Exclude main worktree
  if (normalizedPath === mainWorktreePath) {
    return;
  }

  // Check if this path starts with any excluded prefix
  for (const excludePrefix of excludePrefixes) {
    if (normalizedPath.startsWith(excludePrefix + path.sep) || normalizedPath === excludePrefix) {
      return; // Skip this worktree
    }
  }

  // Extract display name from path (last directory component)
  const displayName = path.basename(normalizedPath);

  results.push({
    path: normalizedPath,
    branch: wt.branch ?? null, // null indicates detached HEAD state
    commitSha: wt.head.substring(0, GIT_PORCELAIN.COMMIT_SHA_LENGTH),
    displayName,
  });
}

async function removeTerminalWorktree(
  projectPath: string,
  name: string,
  deleteBranch: boolean = false
): Promise<IPCResult> {
  debugLog('[TerminalWorktree] Removing worktree:', { name, deleteBranch, projectPath });

  // Validate projectPath against registered projects
  if (!isValidProjectPath(projectPath)) {
    return { success: false, error: 'Invalid project path' };
  }

  // Validate worktree name to prevent path traversal
  if (!WORKTREE_NAME_REGEX.test(name)) {
    return { success: false, error: 'Invalid worktree name' };
  }

  // Auto-fix any misconfigured bare repo before worktree operations
  if (await fixMisconfiguredBareRepo(projectPath)) {
    debugLog('[TerminalWorktree] Fixed misconfigured bare repository at:', projectPath);
  }

  const worktreePath = getTerminalWorktreePath(projectPath, name);
  const config = loadWorktreeConfig(projectPath, name);

  if (!config) {
    return { success: false, error: 'Worktree not found' };
  }

  try {
    // Use the robust cleanupWorktree utility to handle Windows file locks and orphaned worktrees
    const cleanupResult = await cleanupWorktree({
      worktreePath,
      projectPath,
      specId: name,
      logPrefix: '[TerminalWorktree]',
      deleteBranch: deleteBranch && config.hasGitBranch,
      branchName: config.branchName || undefined,
    });

    if (!cleanupResult.success) {
      return {
        success: false,
        error: cleanupResult.warnings.join('; ') || 'Failed to remove worktree',
      };
    }

    // Log warnings if any occurred during cleanup
    if (cleanupResult.warnings.length > 0) {
      debugLog('[TerminalWorktree] Cleanup completed with warnings:', cleanupResult.warnings);
    }

    // Remove metadata file
    const metadataPath = getTerminalWorktreeMetadataPath(projectPath, name);
    if (existsSync(metadataPath)) {
      try {
        rmSync(metadataPath);
        debugLog('[TerminalWorktree] Removed metadata file:', metadataPath);
      } catch {
        debugLog('[TerminalWorktree] Could not remove metadata file:', metadataPath);
      }
    }

    return { success: true };
  } catch (error) {
    debugError('[TerminalWorktree] Error removing worktree:', error);

    // Check if error was due to timeout
    const isTimeout = isTimeoutError(error);

    return {
      success: false,
      error: isTimeout
        ? 'Git operation timed out. The repository may be too large. Please try again.'
        : error instanceof Error
          ? error.message
          : 'Failed to remove worktree',
    };
  }
}

export function registerTerminalWorktreeHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_WORKTREE_CREATE,
    async (_, request: CreateTerminalWorktreeRequest): Promise<TerminalWorktreeResult> => {
      return createTerminalWorktree(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_WORKTREE_LIST,
    async (_, projectPath: string): Promise<IPCResult<TerminalWorktreeConfig[]>> => {
      try {
        const configs = await listTerminalWorktrees(projectPath);
        return { success: true, data: configs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list worktrees',
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_WORKTREE_REMOVE,
    async (
      _,
      projectPath: string,
      name: string,
      deleteBranch: boolean
    ): Promise<IPCResult> => {
      return removeTerminalWorktree(projectPath, name, deleteBranch);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_WORKTREE_LIST_OTHER,
    async (_, projectPath: string): Promise<IPCResult<OtherWorktreeInfo[]>> => {
      try {
        const worktrees = await listOtherWorktrees(projectPath);
        return { success: true, data: worktrees };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list other worktrees',
        };
      }
    }
  );
}
