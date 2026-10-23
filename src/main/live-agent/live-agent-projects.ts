/**
 * The "Live agent" setting, per project: on while the project has a .workbench/flow directory.
 * Switching it on sets the project up (project-setup.ts) and starts the relay; it keeps running
 * while any project has Live agent on, until the app quits.
 */

import { promises as fsPromises } from 'fs';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { whenShellRuntimeReady } from '../platform/shell-runtime';
import { liveAgentRelay } from './live-agent-relay';
import { addToWorktree, getFlowDir, listWorktrees, removeFromProject, removeFromWorktree, setUpProject } from './project-setup';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether a path is one of the user's projects (the renderer only names those) */
export function isKnownProject(projectPath: string): boolean {
  return typeof projectPath === 'string' && projectStore.getProjects().some((project) => project.path === projectPath);
}

/** Whether Live agent is on for the project (its flow directory exists) */
export async function isLiveAgentEnabled(projectPath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(getFlowDir(projectPath))).isDirectory();
  } catch {
    return false;
  }
}

/** Whether any of the user's projects has Live agent on */
async function anyProjectEnabled(): Promise<boolean> {
  const states = await Promise.all(projectStore.getProjects().map((project) => isLiveAgentEnabled(project.path)));
  return states.some(Boolean);
}

/** Give each of the project's worktrees its hooks (a copy of the project's settings.local.json) */
async function addToWorktrees(projectPath: string): Promise<void> {
  for (const worktree of await listWorktrees(projectPath)) {
    try {
      addToWorktree(projectPath, worktree);
    } catch (error) {
      appLog.warn(`[LiveAgent] Could not set up the worktree ${worktree}: ${errorMessage(error)}`);
    }
  }
}

/**
 * Switch Live agent on or off for a project. On: the flow directory is created and the setup runs
 * (hook script, Claude Code hooks in .claude/settings.local.json of the project and its worktrees),
 * and the relay starts. Off: the hooks leave the project's and its worktrees' settings, the flow
 * directory goes (hook script and discovery files with it), and the relay stops once no project
 * has Live agent on. Returns why the hooks couldn't be configured, when only they failed.
 */
export async function setLiveAgentEnabled(projectPath: string, enabled: boolean): Promise<{ hooksError?: string }> {
  if (enabled) {
    // The hook command depends on where WSL mounts Windows drives (startup detection)
    await whenShellRuntimeReady();
    const result = setUpProject(projectPath);
    await addToWorktrees(projectPath);
    liveAgentRelay.setEnabled(true);
    return result;
  }
  for (const worktree of await listWorktrees(projectPath)) {
    try {
      removeFromWorktree(projectPath, worktree);
    } catch (error) {
      appLog.warn(`[LiveAgent] Could not remove the hooks from the worktree ${worktree}: ${errorMessage(error)}`);
    }
  }
  liveAgentRelay.dropProject(getFlowDir(projectPath));
  removeFromProject(projectPath);
  if (!(await anyProjectEnabled())) liveAgentRelay.setEnabled(false);
  return {};
}

/**
 * At startup: run the setup again for projects with Live agent on (it only writes when something
 * changed, e.g. Workbench's executable moved) and start the relay when any has it on
 */
export async function syncLiveAgentAtStartup(): Promise<void> {
  await whenShellRuntimeReady();
  let anyEnabled = false;
  for (const project of projectStore.getProjects()) {
    if (!(await isLiveAgentEnabled(project.path))) continue;
    anyEnabled = true;
    try {
      setUpProject(project.path);
      await addToWorktrees(project.path);
    } catch (error) {
      appLog.warn(`[LiveAgent] Could not refresh the setup of ${project.path}: ${errorMessage(error)}`);
    }
  }
  if (anyEnabled) liveAgentRelay.setEnabled(true);
}
