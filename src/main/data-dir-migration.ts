/**
 * Data folder migration
 *
 * Older versions kept a project's data in .workbench/specs (tasks), .workbench/memory (the
 * Graphify graph) and .workbench/insights (Claude page chats). They are now tasks, knowledge
 * and chats (DATA_DIR_NAMES). This renames the old folders, in the project and in each task
 * worktree's copy of its task folder, when the app starts and when a project is added.
 *
 * A folder is only moved when the new one does not exist yet or is empty, so data is never
 * overwritten; a project with both an old and a non-empty new folder keeps both (logged).
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { DATA_DIR_NAMES, LEGACY_DATA_DIR_NAMES } from '../shared/constants';
import { appLog } from './app-logger';

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

/** Rename `<base>/<legacy>` to `<base>/<current>`; true when something was moved */
async function migrateFolder(base: string, legacy: string, current: string): Promise<boolean> {
  const from = path.join(base, legacy);
  const to = path.join(base, current);
  if (!(await isDirectory(from))) return false;
  if (await isDirectory(to)) {
    if (!(await isEmptyDirectory(to))) {
      appLog.warn(`[DataDirMigration] Both ${from} and ${to} exist; leaving ${from} in place`);
      return false;
    }
    await fsp.rmdir(to);
  }
  await fsp.rename(from, to);
  return true;
}

/**
 * Move a project's data folders to their current names (tasks, knowledge, chats), including
 * the task folder copies inside its task worktrees. Never throws.
 */
export async function migrateProjectDataDirs(projectPath: string, autoBuildPath?: string): Promise<void> {
  const dataDir = path.join(projectPath, autoBuildPath || '.workbench');
  if (!(await isDirectory(dataDir))) return;
  try {
    const moved: string[] = [];
    for (const key of Object.keys(DATA_DIR_NAMES) as (keyof typeof DATA_DIR_NAMES)[]) {
      if (await migrateFolder(dataDir, LEGACY_DATA_DIR_NAMES[key], DATA_DIR_NAMES[key])) {
        moved.push(`${LEGACY_DATA_DIR_NAMES[key]} -> ${DATA_DIR_NAMES[key]}`);
      }
    }

    // Each task worktree holds a copy of its task folder (.workbench is gitignored)
    const worktreesDir = path.join(dataDir, 'worktrees', 'tasks');
    let worktrees: string[] = [];
    try {
      worktrees = (await fsp.readdir(worktreesDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      // No task worktrees
    }
    for (const worktree of worktrees) {
      const worktreeDataDir = path.join(worktreesDir, worktree, autoBuildPath || '.workbench');
      if (await migrateFolder(worktreeDataDir, LEGACY_DATA_DIR_NAMES.tasks, DATA_DIR_NAMES.tasks)) {
        moved.push(`worktrees/tasks/${worktree}: ${LEGACY_DATA_DIR_NAMES.tasks} -> ${DATA_DIR_NAMES.tasks}`);
      }
    }

    if (moved.length > 0) appLog.info(`[DataDirMigration] ${projectPath}: ${moved.join(', ')}`);
  } catch (error) {
    appLog.error(`[DataDirMigration] Failed to migrate ${projectPath}:`, error);
  }
}
