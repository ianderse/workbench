import type { Project } from '../shared/types';
import { appLog } from './app-logger';
import { refreshProjectProgress } from './project-progress';
import { projectStore } from './project-store';
import { taskHooks } from './task-hooks';

let stopService: (() => void) | undefined;

/**
 * One host-owned refresh after task state changes/integration, rather than competing agent edits.
 * Merge hooks never wait for this projection or fail because it could not be written.
 */
export function registerProjectProgressService(): () => void {
  if (stopService) return stopService;
  let stopped = false;
  const queued = new Map<string, { pending: boolean }>();

  const schedule = (project: Project): void => {
    if (stopped) return;
    const existing = queued.get(project.id);
    if (existing) { existing.pending = true; return; }
    const entry = { pending: true };
    queued.set(project.id, entry);
    // Coalesce synchronous hooks, and reread records only when this project's turn starts.
    void Promise.resolve().then(async () => {
      try {
        while (!stopped && entry.pending) {
          entry.pending = false;
          try {
            const current = projectStore.getProject(project.id);
            if (!current) continue;
            projectStore.invalidateTasksCache(current.id);
            await refreshProjectProgress(current, projectStore.getTasks(current.id));
          } catch (error) {
            appLog.warn('[ProjectProgress] Could not refresh integrated project progress:', error);
          }
        }
      } finally {
        if (queued.get(project.id) === entry) queued.delete(project.id);
      }
    });
  };

  const offMerged = taskHooks.on('merged', ({ project }) => schedule(project));
  const offAutoMerged = taskHooks.on('auto-merged', ({ project }) => schedule(project));
  const offPublished = taskHooks.on('integration-published', ({ project }) => schedule(project));
  const offState = taskHooks.on('state', ({ project }) => schedule(project));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    offMerged();
    offAutoMerged();
    offPublished();
    offState();
    // An already-started atomic refresh may finish; nothing else is scheduled after disposal.
    queued.clear();
    if (stopService === stop) stopService = undefined;
  };
  stopService = stop;
  return stop;
}
