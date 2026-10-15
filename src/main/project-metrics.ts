/**
 * Project metrics
 *
 * Spending per project for Settings > Accounts: the sum of every task's Claude Code run cost
 * (`totalCostUsd` in `<specDir>/claude_run.json`) in projects whose `.workbench` directory is
 * initialized. All file access is async so the main process stays responsive.
 */
import path from 'path';
import { promises as fsp } from 'fs';
import { getSpecsDir } from '../shared/constants';
import { CLAUDE_RUN_FILE } from './claude-code/task-runner';
import type { Project, ProjectCostMetrics } from '../shared/types';

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Run cost of one task (0 when it never ran or its run file is unreadable) */
async function readTaskCost(specDir: string): Promise<number> {
  try {
    const info = JSON.parse(await fsp.readFile(path.join(specDir, CLAUDE_RUN_FILE), 'utf-8')) as { totalCostUsd?: unknown };
    return typeof info.totalCostUsd === 'number' && Number.isFinite(info.totalCostUsd) ? info.totalCostUsd : 0;
  } catch {
    return 0;
  }
}

/** Task count and total run cost of each initialized project */
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
      const costs = await Promise.all(specDirs.map(readTaskCost));
      return {
        projectId: project.id,
        name: project.name,
        path: project.path,
        taskCount: specDirs.length,
        totalCostUsd: costs.reduce((sum, cost) => sum + cost, 0),
      };
    })
  );
  return results.filter((metrics): metrics is ProjectCostMetrics => metrics !== null);
}
