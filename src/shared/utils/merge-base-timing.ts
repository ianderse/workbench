/**
 * When a running task takes in the base branch after other tasks were merged into it (project
 * setting `mergeBaseDuring`): once, right before validation (default), or as soon as the merge
 * happens (the notice tells the agent to merge at once).
 */
import type { ProjectSettings } from '../types/project';

export type MergeBaseDuring = 'validate' | 'immediately';

export function resolveMergeBaseDuring(settings: Pick<ProjectSettings, 'mergeBaseDuring'> | undefined): MergeBaseDuring {
  return settings?.mergeBaseDuring === 'immediately' ? 'immediately' : 'validate';
}
