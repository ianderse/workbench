/**
 * Previous runs of a task
 * =======================
 *
 * Starting a task over throws away everything its last run produced: its step logs
 * (`task_logs.json`) and its Claude Code run state (`claude_run.json`), cost included. The run
 * is still worth looking at afterwards — it is usually the reason the task is being redone — so
 * it is moved into `<specDir>/previous_runs/<nnn>/` first and the task dialog lists it next to
 * the current run.
 *
 * The folder survives the spec dir reset (see `resetSpecDirToInitialState`).
 */

import path from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'fs';
import type { ArchivedTaskRun, TaskLogs } from '../shared/types';
import type { ClaudeRunInfo } from '../shared/types/claude-code';
import { safeParseJson } from './utils/json-repair';

export const PREVIOUS_RUNS_DIR = 'previous_runs';

/** Files of a run worth keeping when the task starts over */
const ARCHIVED_FILES = ['task_logs.json', 'claude_run.json'] as const;

/** `1` -> `001`, so the folders sort in run order */
function folderName(index: number): string {
  return String(index).padStart(3, '0');
}

/** Archived run folders, oldest first */
function runFolders(specDir: string): string[] {
  const dir = path.join(specDir, PREVIOUS_RUNS_DIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readJson<T>(file: string): T | null {
  try {
    return safeParseJson<T>(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Put the current run aside before the task starts over.
 *
 * @returns the number the run was filed under, or null when it had nothing worth keeping
 */
export function archiveCurrentRun(specDir: string): number | null {
  const present = ARCHIVED_FILES.filter((file) => existsSync(path.join(specDir, file)));
  if (present.length === 0) return null;

  const index = runFolders(specDir).length + 1;
  const target = path.join(specDir, PREVIOUS_RUNS_DIR, folderName(index));
  try {
    mkdirSync(target, { recursive: true });
    for (const file of present) {
      renameSync(path.join(specDir, file), path.join(target, file));
    }
    return index;
  } catch (error) {
    // Keeping the old run is never worth failing the restart over
    console.warn('[TaskRunArchive] Could not keep the previous run:', error);
    return null;
  }
}

/** Every run the task has already been through, oldest first */
export function listPreviousRuns(specDir: string): ArchivedTaskRun[] {
  const runs: ArchivedTaskRun[] = [];
  for (const folder of runFolders(specDir)) {
    const dir = path.join(specDir, PREVIOUS_RUNS_DIR, folder);
    const logs = readJson<TaskLogs>(path.join(dir, 'task_logs.json'));
    const run = readJson<ClaudeRunInfo>(path.join(dir, 'claude_run.json'));
    if (!logs && !run) continue;

    let archivedAt = run?.updatedAt ?? logs?.updated_at;
    if (!archivedAt) {
      try {
        archivedAt = statSync(dir).mtime.toISOString();
      } catch {
        archivedAt = new Date(0).toISOString();
      }
    }

    runs.push({
      index: Number(folder),
      archivedAt,
      logs,
      phases: Array.isArray(run?.phases) ? run.phases : [],
      ...(typeof run?.totalCostUsd === 'number' ? { totalCostUsd: run.totalCostUsd } : {}),
    });
  }
  return runs;
}
