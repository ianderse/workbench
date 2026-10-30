/**
 * The Claude account a project runs on. Each project window has its own: switching the account
 * in a window saves it as the project's `claudeProfileId` (`.workbench/settings.json`), and a
 * project without one runs on the account in use (the one the user last switched to).
 */
import type { ClaudeProfile } from '../shared/types';
import { projectStore } from './project-store';
import { listProjectWindows } from './window-manager';

/** The profile lookup the account helpers need (the Claude profile manager) */
interface ProfileLookup {
  getProfile(profileId: string): ClaudeProfile | undefined;
}

/** The account saved for the project at `projectPath`, while that account still exists */
export function projectAccount(
  profileManager: ProfileLookup,
  projectPath: string | undefined
): ClaudeProfile | undefined {
  if (!projectPath) return undefined;
  const id = projectStore.getProjects().find((project) => project.path === projectPath)?.settings?.claudeProfileId;
  return id ? profileManager.getProfile(id) : undefined;
}

/**
 * Keep the projects open in other windows on the account they use now (`currentAccountId`, the
 * account in use) when they have none of their own, so a switch in one window doesn't change
 * theirs. Returns whether any project was saved.
 */
export function keepOpenProjectsOnAccount(
  profileManager: ProfileLookup,
  currentAccountId: string,
  exceptProjectId: string
): boolean {
  let saved = false;
  for (const { projectId } of listProjectWindows()) {
    if (!projectId || projectId === exceptProjectId) continue;
    const project = projectStore.getProject(projectId);
    const own = project?.settings?.claudeProfileId;
    if (!project || (own && profileManager.getProfile(own))) continue;
    projectStore.updateProjectSettings(projectId, { claudeProfileId: currentAccountId });
    saved = true;
  }
  return saved;
}
