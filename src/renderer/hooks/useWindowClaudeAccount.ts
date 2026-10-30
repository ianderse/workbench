import { useClaudeProfileStore, loadClaudeProfiles } from '../stores/claude-profile-store';
import { useProjectStore } from '../stores/project-store';
import type { ClaudeProfile, IPCResult } from '../../shared/types';

/**
 * The account a project runs on: its own (saved when the account is switched in its window, or
 * on its settings page) while that account exists, else the account in use
 */
export function projectClaudeAccountId(
  profiles: ClaudeProfile[],
  activeProfileId: string,
  projectProfileId: string | undefined
): string {
  return projectProfileId && profiles.some((profile) => profile.id === projectProfileId)
    ? projectProfileId
    : activeProfileId;
}

/** The project this window shows */
function windowProjectId(): string | null {
  const state = useProjectStore.getState();
  return state.activeProjectId ?? state.selectedProjectId;
}

/** The Claude account this window's project runs on (each window can be on its own account) */
export function useWindowClaudeAccountId(): string {
  const profiles = useClaudeProfileStore((state) => state.profiles);
  const activeProfileId = useClaudeProfileStore((state) => state.activeProfileId);
  const projectProfileId = useProjectStore((state) => {
    const id = state.activeProjectId ?? state.selectedProjectId;
    return state.projects.find((project) => project.id === id)?.settings?.claudeProfileId;
  });
  return projectClaudeAccountId(profiles, activeProfileId, projectProfileId);
}

/**
 * Switch the Claude account in this window: saved as the window's project's account (its agent
 * windows move to it) and made the account in use, which projects without one of their own and
 * new windows start on. `projectId` defaults to the window's project.
 */
export async function switchClaudeAccount(
  profileId: string,
  projectId: string | null = windowProjectId()
): Promise<IPCResult> {
  const result = await window.electronAPI.setActiveClaudeProfile(profileId, projectId ?? undefined);
  if (result.success && projectId) {
    // Saved by the main process; the store follows
    const store = useProjectStore.getState();
    const project = store.projects.find((p) => p.id === projectId);
    if (project) store.updateProject(projectId, { settings: { ...project.settings, claudeProfileId: profileId } });
  }
  await loadClaudeProfiles();
  return result;
}
