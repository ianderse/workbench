/**
 * The "Live agent" setting, per project: on while the project has a .auto-claude/flow directory.
 * Switching it on sets the project up (project-setup.ts) and starts the relay; it keeps running
 * while any project has Live agent on, until the app quits.
 */

import { promises as fsPromises } from 'fs';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { liveAgentRelay } from './live-agent-relay';
import { getFlowDir, removeFromProject, setUpProject } from './project-setup';

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

/**
 * Switch Live agent on or off for a project. On: the flow directory is created and the setup runs
 * (hook script, Claude Code hooks in .claude/settings.local.json), and the relay starts. Off: the
 * hooks and the directory go, and the relay stops once no project has Live agent on.
 * Returns why the hooks couldn't be configured, when only they failed.
 */
export async function setLiveAgentEnabled(projectPath: string, enabled: boolean): Promise<{ hooksError?: string }> {
  if (enabled) {
    const result = setUpProject(projectPath);
    liveAgentRelay.setEnabled(true);
    return result;
  }
  removeFromProject(projectPath);
  if (!(await anyProjectEnabled())) liveAgentRelay.setEnabled(false);
  return {};
}

/**
 * At startup: run the setup again for projects with Live agent on (it only writes when something
 * changed, e.g. Auto Claude's executable moved) and start the relay when any has it on
 */
export async function syncLiveAgentAtStartup(): Promise<void> {
  let anyEnabled = false;
  for (const project of projectStore.getProjects()) {
    if (!(await isLiveAgentEnabled(project.path))) continue;
    anyEnabled = true;
    try {
      setUpProject(project.path);
    } catch (error) {
      appLog.warn(`[LiveAgent] Could not refresh the setup of ${project.path}: ${errorMessage(error)}`);
    }
  }
  if (anyEnabled) liveAgentRelay.setEnabled(true);
}
