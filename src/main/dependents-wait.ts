/**
 * Make unstarted dependents of a task wait for the tickets that continue its scope (follow-ups,
 * decision tickets). Rules are pure in shared/utils/dependents-wait.ts; the update goes through
 * `GroomingDeps.updateTask` like the rewiring in task-split.ts, so the board refreshes.
 * Never throws.
 */
import { addDependencyToDependents } from '../shared/utils/dependents-wait';
import type { GroomingDeps } from './queue-grooming';
import { appLog } from './app-logger';

/** Returns the ids of the tickets that now wait for `newIds` */
export async function makeDependentsWait(
  deps: Pick<GroomingDeps, 'getTasks' | 'updateTask'>,
  projectId: string,
  sourceIds: readonly string[],
  newIds: readonly string[],
  newDependsOn: Record<string, string[]> = {}
): Promise<string[]> {
  const changed: string[] = [];
  try {
    const updates = addDependencyToDependents(deps.getTasks(projectId), sourceIds, newIds, newDependsOn);
    for (const [taskId, dependsOnTaskIds] of Object.entries(updates)) {
      try {
        await deps.updateTask(projectId, taskId, { metadata: { dependsOnTaskIds } });
        changed.push(taskId);
      } catch (error) {
        appLog.warn(`[Dependents] Could not make ${taskId} wait for ${newIds.join(', ')}:`, error);
      }
    }
  } catch (error) {
    appLog.warn('[Dependents] Could not update dependents:', error);
  }
  return changed;
}
