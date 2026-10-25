/**
 * Notifications for the autonomous workflow, driven by the task hooks: task merged, decision
 * needed, needs attention and "all work done". The text and timing rules are pure
 * (`shared/utils/notification-events.ts`); delivery (desktop and phone) is `notification-service.ts`.
 */
import { taskHooks } from './task-hooks';
import { notificationService } from './notification-service';
import { projectStore } from './project-store';
import { appLog } from './app-logger';
import {
  DecisionBatcher,
  QueueEmptyTracker,
  countWaiting,
  decisionNeededContent,
  hasActiveWork,
  needsAttentionContent,
  queueEmptyContent,
  taskDoneContent,
  taskMergedContent,
} from '../shared/utils/notification-events';

let started = false;

function safely(name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    appLog.warn(`[Notifications] ${name} failed:`, error);
  }
}

export function startNotificationHooks(): void {
  if (started) return;
  started = true;

  const projectTasks = (projectId: string) => projectStore.getTasks(projectId);

  const tracker = new QueueEmptyTracker(
    (projectId, merged) =>
      safely('all work done', () => {
        const project = projectStore.getProject(projectId);
        if (!project) return;
        notificationService.notifyContent(
          queueEmptyContent(projectId, project.name, merged, countWaiting(projectTasks(projectId)))
        );
      }),
    (projectId) => !hasActiveWork(projectTasks(projectId))
  );

  const batcher = new DecisionBatcher((projectId, tickets) =>
    safely('decision needed', () => {
      const content = decisionNeededContent(projectId, tickets);
      if (content) notificationService.notifyContent(content);
    })
  );

  // Tasks already announced as merged (an auto-merge that is later marked Done is one merge)
  const mergedNotified = new Set<string>();
  const markMerged = (projectId: string, taskId: string): boolean => {
    const key = `${projectId}\0${taskId}`;
    if (mergedNotified.has(key)) return false;
    mergedNotified.add(key);
    return true;
  };

  taskHooks.on('auto-merged', ({ project, task, into }) =>
    safely('task merged', () => {
      if (!markMerged(project.id, task.id)) return;
      tracker.recordMerge(project.id);
      notificationService.notifyContent(taskMergedContent(project.id, task, into));
    })
  );

  taskHooks.on('merged', ({ project, task }) =>
    safely('task done', () => {
      // Already announced by the auto-merge: Done only cleans up
      if (task.metadata?.autoMerge || !markMerged(project.id, task.id)) return;
      tracker.recordMerge(project.id);
      notificationService.notifyContent(taskDoneContent(project.id, task));
    })
  );

  taskHooks.on('decision-needed', ({ project, tickets }) => batcher.add(project.id, tickets));

  taskHooks.on('needs-attention', ({ project, task, reason, detail }) =>
    safely('needs attention', () => {
      notificationService.notifyContent(needsAttentionContent(project.id, task, reason, detail));
    })
  );

  taskHooks.on('state', ({ project, task, status }) =>
    safely('state', () => {
      if (status === 'error') {
        notificationService.notifyContent(needsAttentionContent(project.id, task, 'error'));
      }
      // The event carries the new status; the stored list may not have caught up yet
      const others = projectTasks(project.id).filter((t) => t.id !== task.id);
      tracker.observe(project.id, hasActiveWork([...others, { status, metadata: task.metadata }]));
    })
  );
}
