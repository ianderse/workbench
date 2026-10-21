/**
 * Project metrics
 *
 * Spending per project for Settings > Accounts: the sum of every task's Claude Code run cost
 * (`totalCostUsd` in `<specDir>/claude_run.json`) in projects whose `.workbench` directory is
 * initialized. A task that was started over has also spent what its earlier runs cost, so the
 * runs kept under `previous_runs/` count too. Each run's steps carry their own cost and start
 * time, which also gives the project's spending per calendar day for the usage chart. All file
 * access is async so the main process stays responsive.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { getSpecsDir } from '../shared/constants';
import { CLAUDE_RUN_FILE } from './claude-code/task-runner';
import { PREVIOUS_RUNS_DIR } from './task-run-archive';
import type { ClaudeRunInfo } from '../shared/types/claude-code';
import type { Project, ProjectCostMetrics, ProjectDailyCost } from '../shared/types';

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The run's state, or null when it never ran or its run file is unreadable */
async function readRun(runFile: string): Promise<Partial<ClaudeRunInfo> | null> {
  try {
    return JSON.parse(await fsp.readFile(runFile, 'utf-8')) as Partial<ClaudeRunInfo>;
  } catch {
    return null;
  }
}

function spentUsd(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Local calendar day of a timestamp (`YYYY-MM-DD`), or null when it is missing or unparsable */
function dayOf(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function addSpending(byDay: Map<string, number>, day: string, costUsd: number): void {
  byDay.set(day, (byDay.get(day) ?? 0) + costUsd);
}

/**
 * Books one run's cost on the days it was spent: every step on the day it started, and anything
 * the total holds beyond the steps (older runs whose steps carry no cost) on the day the run was
 * last written. Returns what the run cost in total.
 */
function bookRunSpending(run: Partial<ClaudeRunInfo>, byDay: Map<string, number>): number {
  const total = spentUsd(run.totalCostUsd);
  const lastWritten = dayOf(run.updatedAt);
  let booked = 0;

  for (const phase of Array.isArray(run.phases) ? run.phases : []) {
    const costUsd = spentUsd(phase?.costUsd);
    const day = dayOf(phase?.startedAt) ?? lastWritten;
    if (!costUsd || !day) continue;
    addSpending(byDay, day, costUsd);
    booked += costUsd;
  }

  const rest = total - booked;
  if (rest > 0 && lastWritten) addSpending(byDay, lastWritten, rest);
  return total;
}

/** Run files of the runs a task was started over from */
async function previousRunFiles(specDir: string): Promise<string[]> {
  const archive = path.join(specDir, PREVIOUS_RUNS_DIR);
  try {
    const entries = await fsp.readdir(archive, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(archive, entry.name, CLAUDE_RUN_FILE));
  } catch {
    // Never started over
    return [];
  }
}

/** What one task has cost: its current run plus every run it was started over from */
async function readTaskRuns(specDir: string): Promise<Array<Partial<ClaudeRunInfo> | null>> {
  const runFiles = [path.join(specDir, CLAUDE_RUN_FILE), ...(await previousRunFiles(specDir))];
  return Promise.all(runFiles.map(readRun));
}

/** Spending per day, oldest first; days without spending are left out */
function toDailyCosts(byDay: Map<string, number>): ProjectDailyCost[] {
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, costUsd]) => ({ date, costUsd }));
}

/** Task count, total run cost and spending per day of each initialized project */
export async function getProjectCostMetrics(projects: Project[]): Promise<ProjectCostMetrics[]> {
  const results = await Promise.all(
    projects.map(async (project): Promise<ProjectCostMetrics | null> => {
      const workbenchDir = path.join(project.path, project.autoBuildPath || '.workbench');
      if (!(await isDirectory(workbenchDir))) return null;

      const specsDir = path.join(project.path, getSpecsDir(project.autoBuildPath));
      let specDirs: string[] = [];
      try {
        const entries = await fsp.readdir(specsDir, { withFileTypes: true });
        specDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(specsDir, entry.name));
      } catch {
        // No specs yet
      }

      const runsPerTask = await Promise.all(specDirs.map(readTaskRuns));
      const byDay = new Map<string, number>();
      const totalCostUsd = runsPerTask
        .flat()
        .reduce((sum, run) => (run ? sum + bookRunSpending(run, byDay) : sum), 0);

      return {
        projectId: project.id,
        name: project.name,
        path: project.path,
        taskCount: specDirs.length,
        totalCostUsd,
        daily: toDailyCosts(byDay),
      };
    })
  );
  return results.filter((metrics): metrics is ProjectCostMetrics => metrics !== null);
}
