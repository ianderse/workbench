/**
 * Task messaging: parallel tasks message each other through Workbench (`broker.ts`) and get its
 * notices about each other (`notices.ts`).
 */
import type { AppSettings } from '../../shared/types/settings';
import { projectStore } from '../project-store';
import { readSettingsFile } from '../settings-utils';
import { resolveClaudeCodeTaskSettings } from '../claude-code/settings';
import type { Project, Task } from '../../shared/types';
import { appLog } from '../app-logger';
import { resolveDefaultBaseBranch } from '../utils/base-branch';
import { configureTaskMessaging } from './broker';
import { TaskNotices } from './notices';
import { isBranchMergedInto } from './merge-sync';
import { taskResync } from '../task-resync';

export { deliverToTask } from './broker';

/** Whether task messaging is on (Settings > Agents) */
export function isTaskMessagingEnabled(): boolean {
  const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
  return resolveClaudeCodeTaskSettings(settings.claudeCodeTasks).taskMessaging;
}

let notices: TaskNotices | null = null;

/** Start the broker and its notices (once, at app start); returns a function that stops them */
export function registerTaskMessaging(options: { isRunning?: (taskId: string, projectId: string) => boolean } = {}): () => void {
  configureTaskMessaging({
    getProject: (projectId) => projectStore.getProject(projectId),
    getTasks: (projectId) => projectStore.getTasks(projectId),
  });
  notices?.stop();
  notices = new TaskNotices({
    isEnabled: isTaskMessagingEnabled,
    isRunning: options.isRunning ? (projectId, task) => options.isRunning!(task.id, projectId) : undefined,
    defaultBranch: (project) => resolveDefaultBaseBranch(project.path),
    // Tasks on the merged branch that are not running go back to In Progress to take it in
    requestResync: (project, task) => taskResync.request(project.id, task.id),
    // Merged locally: the task branch has commits of its own and is in its base branch (a merged
    // PR sets prState instead). `HEAD` (a detached worktree) would name the project's own HEAD here
    isMerged: async (project, _task, branch, base) => {
      if (!branch || branch === 'HEAD') return false;
      return isBranchMergedInto(project.path, branch, base);
    },
  }).start();
  return () => {
    notices?.stop();
    notices = null;
    configureTaskMessaging(null);
  };
}

/**
 * A task is about to be moved to Done by hand: find out now whether its branch was merged
 * outside Workbench (the move deletes the branch, and the merge sync needs to know)
 */
export async function noteTaskMergeBeforeDone(project: Project, task: Task): Promise<void> {
  try {
    await notices?.noteMergeBeforeDone(project, task);
  } catch (error) {
    appLog.warn(`[TaskMessaging] Could not check whether ${task.specId} was merged:`, error);
  }
}
