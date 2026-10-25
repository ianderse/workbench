import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import path from 'path';
import { git } from './utils/git-exec';
import { stageTaskWork } from './claude-code/stage-excludes';
import { DATA_DIR_NAMES } from '../shared/constants';

/**
 * Debug logging - only logs when DEBUG=true or in development mode
 */
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debug(message: string, data?: Record<string, unknown>): void {
  if (DEBUG) {
    if (data) {
      console.warn(`[ProjectInitializer] ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.warn(`[ProjectInitializer] ${message}`);
    }
  }
}

/**
 * Git status information for a project
 */
export interface GitStatus {
  isGitRepo: boolean;
  hasCommits: boolean;
  currentBranch: string | null;
  error?: string;
}

/**
 * Check if a directory is a git repository and has at least one commit
 */
export async function checkGitStatus(projectPath: string): Promise<GitStatus> {
  try {
    // Check if it's a git repository
    await git(['rev-parse', '--git-dir'], {
      cwd: projectPath,
      encoding: 'utf-8'
    });
  } catch {
    return {
      isGitRepo: false,
      hasCommits: false,
      currentBranch: null,
      error: 'Not a git repository. Please run "git init" to initialize git.'
    };
  }

  // Check if there are any commits
  let hasCommits = false;
  try {
    await git(['rev-parse', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8'
    });
    hasCommits = true;
  } catch {
    // No commits yet
    hasCommits = false;
  }

  // Get current branch
  let currentBranch: string | null = null;
  try {
    currentBranch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectPath,
      encoding: 'utf-8'
    })).stdout.trim();
  } catch {
    // Branch detection failed
  }

  if (!hasCommits) {
    return {
      isGitRepo: true,
      hasCommits: false,
      currentBranch,
      error: 'Git repository has no commits. Please make an initial commit first.'
    };
  }

  return {
    isGitRepo: true,
    hasCommits: true,
    currentBranch
  };
}

/**
 * Initialize git in a project directory and create an initial commit.
 * This is a user-friendly way to set up git for non-technical users.
 */
export async function initializeGit(projectPath: string): Promise<InitializationResult> {
  debug('initializeGit called', { projectPath });

  // Check current git status
  const status = await checkGitStatus(projectPath);

  try {
    // Step 1: Initialize git if needed
    if (!status.isGitRepo) {
      debug('Initializing git repository');
      await git(['init'], {
        cwd: projectPath,
        encoding: 'utf-8'
      });
    }

    // Step 2: Check if there are files to commit
    const statusOutput = (await git(['status', '--porcelain'], {
      cwd: projectPath,
      encoding: 'utf-8'
    })).stdout.trim();

    // Step 3: If there are untracked/modified files, add and commit them
    if (statusOutput || !status.hasCommits) {
      debug('Adding files and creating initial commit');

      // Add all files
      await stageTaskWork(projectPath, [], { encoding: 'utf-8' });

      // Create initial commit
      await git(['commit', '-m', 'Initial commit', '--allow-empty'], {
        cwd: projectPath,
        encoding: 'utf-8'
      });
    }

    debug('Git initialization complete');
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during git initialization';
    debug('Git initialization failed', { error: errorMessage });
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Entries to add to .gitignore when initializing a project
 */
const GITIGNORE_ENTRIES = ['.workbench/'];

/**
 * Ensure entries exist in the project's .gitignore file.
 * Creates .gitignore if it doesn't exist.
 */
function ensureGitignoreEntries(projectPath: string, entries: string[]): void {
  const gitignorePath = path.join(projectPath, '.gitignore');

  // Read existing content atomically (no TOCTOU)
  let content = '';
  let fileExists = false;
  try {
    content = readFileSync(gitignorePath, 'utf-8');
    fileExists = true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // File doesn't exist - content stays empty
  }

  const existingLines = content ? content.split('\n').map(line => line.trim()) : [];

  // Find entries that need to be added
  const entriesToAdd: string[] = [];
  for (const entry of entries) {
    const entryNormalized = entry.replace(/\/$/, ''); // Remove trailing slash for comparison
    const alreadyExists = existingLines.some(line => {
      const lineNormalized = line.replace(/\/$/, '');
      return lineNormalized === entry || lineNormalized === entryNormalized;
    });

    if (!alreadyExists) {
      entriesToAdd.push(entry);
    }
  }

  if (entriesToAdd.length === 0) {
    debug('All gitignore entries already exist');
    return;
  }

  if (fileExists) {
    // Build the content to append
    let appendContent = '';

    // Ensure file ends with newline before adding our entries
    if (content && !content.endsWith('\n')) {
      appendContent += '\n';
    }

    appendContent += '\n# Workbench data directory\n';
    for (const entry of entriesToAdd) {
      appendContent += entry + '\n';
    }

    appendFileSync(gitignorePath, appendContent);
  } else {
    writeFileSync(gitignorePath, '# Workbench data directory\n' + entriesToAdd.join('\n') + '\n', 'utf-8');
  }

  debug('Added entries to .gitignore', { entries: entriesToAdd });
}

/**
 * Data directories created in .workbench for each project
 */
const DATA_DIRECTORIES = [
  DATA_DIR_NAMES.tasks,
  DATA_DIR_NAMES.chats
];

/**
 * Result of initialization operation
 */
export interface InitializationResult {
  success: boolean;
  error?: string;
}

/**
 * Check if the project has a local backend source directory
 * This indicates it's the development project itself
 */
export function hasLocalSource(projectPath: string): boolean {
  // Use session/runner.ts as marker — ensures valid TypeScript AI layer
  const markerFile = path.join(projectPath, 'src', 'main', 'ai', 'session', 'runner.ts');
  return existsSync(markerFile);
}

/**
 * Check if project is initialized (has .workbench directory)
 */
export function isInitialized(projectPath: string): boolean {
  const dotAutoBuildPath = path.join(projectPath, '.workbench');
  return existsSync(dotAutoBuildPath);
}

/**
 * Initialize the Workbench data directory in a project.
 *
 * Creates .workbench/ with data directories (specs, insights).
 * The framework code runs from the source repo - only data is stored here.
 *
 * Requires:
 * - Project directory must exist
 * - Project must be a git repository with at least one commit
 */
export async function initializeProject(projectPath: string): Promise<InitializationResult> {
  debug('initializeProject called', { projectPath });

  // Validate project path exists
  if (!existsSync(projectPath)) {
    debug('Project path does not exist', { projectPath });
    return {
      success: false,
      error: `Project directory not found: ${projectPath}`
    };
  }

  // Check git status - Workbench requires git for worktree-based builds
  const gitStatus = await checkGitStatus(projectPath);
  if (!gitStatus.isGitRepo || !gitStatus.hasCommits) {
    debug('Git check failed', { gitStatus });
    return {
      success: false,
      error: gitStatus.error || 'Git repository required. Workbench uses git worktrees for isolated builds.'
    };
  }

  // Check if already initialized
  const dotAutoBuildPath = path.join(projectPath, '.workbench');

  if (existsSync(dotAutoBuildPath)) {
    debug('Already initialized - .workbench exists');
    return {
      success: false,
      error: 'Project already has Workbench initialized (.workbench exists)'
    };
  }

  try {
    debug('Creating .workbench data directory', { dotAutoBuildPath });

    // Create the .workbench directory
    mkdirSync(dotAutoBuildPath, { recursive: true });

    // Create data directories
    for (const dataDir of DATA_DIRECTORIES) {
      const dirPath = path.join(dotAutoBuildPath, dataDir);
      debug('Creating data directory', { dataDir, dirPath });
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(path.join(dirPath, '.gitkeep'), '', 'utf-8');
    }

    // Update .gitignore to exclude .workbench/
    ensureGitignoreEntries(projectPath, GITIGNORE_ENTRIES);

    debug('Initialization complete');
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during initialization';
    debug('Initialization failed', { error: errorMessage });
    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Get the Workbench data folder path for a project.
 *
 * IMPORTANT: Only .workbench/ is considered a valid "installed" Workbench.
 * The workbench/ folder (if it exists) is the SOURCE CODE being developed,
 * not an installation. This allows Workbench to be used to develop itself.
 */
export function getAutoBuildPath(projectPath: string): string | null {
  const dotAutoBuildPath = path.join(projectPath, '.workbench');

  debug('getAutoBuildPath called', { projectPath, dotAutoBuildPath });

  if (existsSync(dotAutoBuildPath)) {
    debug('Returning .workbench (installed version)');
    return '.workbench';
  }

  debug('No .workbench folder found - project not initialized');
  return null;
}
