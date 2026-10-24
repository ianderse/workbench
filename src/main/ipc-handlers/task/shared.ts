import type { Task, Project } from '../../../shared/types';
import { projectStore } from '../../project-store';
import { appLog } from '../../app-logger';

/**
 * Helper function to find task and project by taskId.
 *
 * When projectId is provided, the search is strictly scoped to that project.
 * If the task is not found in the specified project, returns undefined (does NOT
 * fall back to other projects). This prevents cross-project contamination when
 * multiple projects have tasks with the same specId.
 *
 * When projectId is NOT provided, searches all projects for backward
 * compatibility with callers that don't have projectId (e.g., file watcher events).
 * A task id is only unique inside its project, so that search is a guess: it returns the first
 * project that happens to hold the id. Callers that act on a task's run (stopping it, checking
 * whether it runs, deleting it) must therefore pass the project the user acted on and must never
 * hand the project this search guessed to `AgentManager`, whose bare task id path refuses an
 * ambiguous id instead of picking one. The guess is logged when two projects hold the id, so the
 * next caller that forgets the project leaves a trace of it.
 */
export const findTaskAndProject = (taskId: string, projectId?: string): { task: Task | undefined; project: Project | undefined } => {
  const projects = projectStore.getProjects();

  // If projectId provided, search ONLY that project (no fallback)
  if (projectId) {
    const targetProject = projects.find((p) => p.id === projectId);
    if (!targetProject) {
      console.warn(`[findTaskAndProject] projectId "${projectId}" not found in projects list, returning undefined`);
      return { task: undefined, project: undefined };
    }
    const tasks = projectStore.getTasks(targetProject.id);
    const task = tasks.find((t) => t.id === taskId || t.specId === taskId);
    return { task, project: task ? targetProject : undefined };
  }

  // No projectId: search the projects in order and take the first that holds the id (the file
  // watcher, whose events carry no project). It stops at that first match on purpose: `getTasks`
  // scans a project's spec directories synchronously when its cache is cold, and these events
  // arrive every few seconds while a task writes its plan file, so looking at every project would
  // block the main process over and over.
  for (const p of projects) {
    const task = projectStore.getTasks(p.id).find((t) => t.id === taskId || t.specId === taskId);
    if (!task) continue;
    warnIfAmbiguous(taskId, p, projects);
    return { task, project: p };
  }

  return { task: undefined, project: undefined };
};

/**
 * Say so when another project holds the same task id, because then the match above was a coin toss
 * and whatever the caller does next lands on one project arbitrarily - which is why every caller
 * that can know its project has to say it.
 *
 * Only the projects whose tasks are already in hand are looked at (`getCachedTasks`), so this costs
 * nothing: in active use they are all cached, and when they are not, the diagnostic is worth less
 * than blocking the main process to produce it.
 */
function warnIfAmbiguous(taskId: string, chosen: Project, projects: Project[]): void {
  for (const other of projects) {
    if (other.id === chosen.id) continue;
    const cached = projectStore.getCachedTasks(other.id);
    if (!cached?.some((t) => t.id === taskId || t.specId === taskId)) continue;
    appLog.warn(
      `[findTaskAndProject] "${taskId}" exists in more than one project ` +
      `(${chosen.id}, ${other.id}) and no projectId was given; using ${chosen.id}`
    );
    return;
  }
}
