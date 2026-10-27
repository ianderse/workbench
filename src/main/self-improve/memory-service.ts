import type { BrowserWindow } from 'electron';
import { readFile, readdir } from 'fs/promises';
import path from 'path';
import type { Project, Task } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/constants';
import { appLog } from '../app-logger';
import { projectStore } from '../project-store';
import { taskHooks } from '../task-hooks';
import { notificationService } from '../notification-service';
import { memoryReviewContent } from '../../shared/utils/notification-events';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { getCompengDir } from './paths';
import { memoryChanged, memoryEvents } from './memory-events';
import { captureTaskMemory, MEMORY_EXTRACTION_VERSION } from './automatic-capture';
import { claimMemoryReviewNotice, listProjectMemories, reviewAutomaticMemories } from './project-memory';
import { isSelfImproveEnabledForPath } from './setting';

let stopService: (() => void) | undefined;
const finished = (task: Task) => task.status === 'done' || (task.status === 'human_review' && (task.reviewReason === 'completed' || task.reviewReason === 'auto_merged'));

/** Completion hooks never wait for extraction. Pending review survives notification settings and restarts. */
export function startMemoryAutomation(getMainWindow: () => BrowserWindow | null = () => null): () => void {
  if (stopService) return stopService;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<void>>();
  let stopped = false;

  const flush = async (projectId: string) => {
    timers.delete(projectId);
    const project = projectStore.getProject(projectId);
    if (!project || !(await isSelfImproveEnabledForPath(project.path))) return;
    const dir = getCompengDir(project.path);
    const pending = (await listProjectMemories(dir, projectId)).filter((entry) => entry.status === 'proposed');
    if (pending.length) await reviewAutomaticMemories(dir, projectId, pending.map((entry) => ({ id: entry.id, expectedRevision: entry.revision })));
    const eligible = projectStore.getTasks(projectId).filter((task) => finished(task) || task.status === 'error').map((task) => task.specId);
    const newlyPending = await claimMemoryReviewNotice(dir, projectId, eligible);
    if (stopped || !newlyPending.length) return;
    notificationService.notifyContent(memoryReviewContent(projectId, project.name, newlyPending));
  };
  const schedule = (projectId: string) => {
    if (stopped || timers.has(projectId)) return;
    const timer = setTimeout(() => { void flush(projectId).catch((error) => appLog.warn('[ProjectMemory] Review notification failed:', error)); }, 2000);
    timer.unref?.(); timers.set(projectId, timer);
  };
  const onChanged = ({ dir, projectId }: { dir: string; projectId: string }) => {
    const project = projectStore.getProject(projectId);
    if (!project || path.resolve(dir) !== path.resolve(getCompengDir(project.path))) return;
    safeSendToRenderer(getMainWindow, IPC_CHANNELS.PROJECT_MEMORY_CHANGED, projectId);
    schedule(projectId);
  };
  memoryEvents.on('changed', onChanged);

  const capture = (project: Project, task: Task, target?: string) => {
    if (stopped || !project.settings.selfImprove) return;
    const key = `${project.id}:${task.specId}`;
    // A merge arriving during extraction must reassess with the now-merged target afterwards.
    const previous = running.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (stopped) return;
      const current = projectStore.getTasks(project.id).find((item) => item.specId === task.specId) ?? task;
      if (!finished(current)) return;
      const complete = await captureTaskMemory(project, current, { target });
      memoryChanged(getCompengDir(project.path), project.id);
      if (!complete && !stopped) {
        const timer = setTimeout(() => { retries.delete(timer); capture(project, current, target); }, 45_000);
        timer.unref?.(); retries.add(timer);
      }
    }).catch((error) => {
      appLog.warn(`[ProjectMemory] Capture failed for ${task.specId}:`, error);
      if (!stopped) {
        const timer = setTimeout(() => { retries.delete(timer); capture(project, task, target); }, 45_000);
        timer.unref?.(); retries.add(timer);
      }
    });
    running.set(key, next);
    void next.finally(() => { if (running.get(key) === next) running.delete(key); });
  };
  const dispose = [
    taskHooks.on('state', ({ project, task, status }) => { if (status === 'human_review' || status === 'done') capture(project, { ...task, status }); if (status === 'error') schedule(project.id); }),
    taskHooks.on('merged', ({ project, task }) => capture(project, { ...task, status: 'done' })),
    taskHooks.on('auto-merged', ({ project, task, into }) => capture(project, { ...task, status: 'human_review', reviewReason: 'auto_merged' }, into)),
  ];
  // Resume only journals from this feature; never ingest the project's entire historical backlog.
  const catchUp = async () => {
    for (const project of projectStore.getProjects()) {
      if (!project.settings.selfImprove) continue;
      schedule(project.id);
      const dir = path.join(getCompengDir(project.path), 'records', 'captures');
      let files: string[];
      try { files = await readdir(dir); } catch { continue; }
      for (const file of files.filter((name) => /^[a-f\d]{64}\.json$/.test(name))) {
        try {
          const job = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as { taskId: string; status: string; attempts?: number; extractionVersion?: number };
          if (job.status === 'complete' || job.status === 'stale'
            || job.extractionVersion === MEMORY_EXTRACTION_VERSION && (job.status === 'failed' || (job.attempts ?? 0) >= 3)) continue;
          const task = projectStore.getTasks(project.id).find((item) => item.specId === job.taskId);
          if (task) capture(project, task);
        } catch (error) { appLog.warn('[ProjectMemory] Capture journal could not be resumed:', error); }
      }
    }
  };
  const startup = setTimeout(() => { void catchUp().catch((error) => appLog.warn('[ProjectMemory] Startup recovery failed:', error)); }, 5000);
  startup.unref?.();
  stopService = () => {
    stopped = true; clearTimeout(startup);
    for (const timer of [...timers.values(), ...retries]) clearTimeout(timer);
    for (const off of dispose) off();
    memoryEvents.off('changed', onChanged);
    stopService = undefined;
  };
  return stopService;
}
