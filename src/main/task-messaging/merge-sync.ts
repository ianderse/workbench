/**
 * Merge sync
 * ==========
 *
 * When a task is merged, every other unfinished task of the project hears about it (In Progress,
 * AI Review, Human Review, PR Created, Error; no file filter), and the ones based on the branch
 * it was merged into take the change in:
 *
 * - running (its run is live, or it is In Progress / AI Review): a `[Workbench]` notice tells it
 *   to merge that branch now (live stdin, or the inbox for its next step);
 * - not running: Workbench merges the branch into the task's worktree itself, when the worktree is
 *   clean, not mid-merge and not being merged right now. Conflicts are undone (the task's own merge
 *   resolves them later) and noted; nothing is pushed. One pull at a time per project;
 * - based on another branch: an informational notice.
 *
 * The merged ref: a local merge's `<base>`; a merged PR's `origin/<base>` after one fetch in the
 * project (the local `<base>` when the fetch fails). No Claude merge agent runs here.
 */
import type { Project, Task, TaskStatus } from '../../shared/types';
import { appLog } from '../app-logger';
import { TaskLogWriter } from '../claude-code/task-log';
import { git } from '../utils/git-exec';
import { findTaskWorktree } from '../worktree-paths';
import { isTaskBranchBusy, runBranchSync } from '../worktree/merge-guard';
import { deliverToTask, getTaskMessagingEnv, isTaskLive, taskSpecDir } from './broker';

/** How a task was merged */
export type MergeVia = 'local' | 'pr';

export interface TaskMergeInfo {
  /** The branch it was merged into */
  into: string;
  via: MergeVia;
}

/** Tasks told about a merge */
export const MERGE_RECIPIENT_STATUSES = new Set<TaskStatus>(['in_progress', 'ai_review', 'human_review', 'pr_created', 'error']);
/** Statuses that mean a run is active or between its steps */
const RUNNING_STATUSES = new Set<TaskStatus>(['in_progress', 'ai_review']);
const MAX_FILES_LISTED = 10;
const RECORD_TTL_MS = 10 * 60_000;

// =============================================================================
// Recorded merges
// =============================================================================

const recorded = new Map<string, TaskMergeInfo & { at: number }>();
const recordKey = (projectId: string, specId: string) => `${projectId}\u0000${specId}`;

/** A branch name as tasks store it: no `origin/` prefix, no "project default" marker */
export function normalizeBranch(branch: string | undefined): string | undefined {
  const name = branch?.trim().replace(/^origin\//, '');
  return name && name !== '__project_default__' ? name : undefined;
}

/** Workbench merged a task (call before moving it to Done): where to, and how */
export function recordTaskMerge(projectId: string, specId: string, info: TaskMergeInfo): void {
  const into = normalizeBranch(info.into);
  if (!into) return;
  recorded.set(recordKey(projectId, specId), { into, via: info.via, at: Date.now() });
}

/** The merge recorded for a task that just entered Done (once) */
export function takeTaskMerge(projectId: string, specId: string): TaskMergeInfo | undefined {
  const key = recordKey(projectId, specId);
  const entry = recorded.get(key);
  recorded.delete(key);
  if (!entry || Date.now() - entry.at > RECORD_TTL_MS) return undefined;
  return { into: entry.into, via: entry.via };
}

// =============================================================================
// Pulling into a worktree
// =============================================================================

export type WorktreePullResult =
  | { status: 'merged' }
  | { status: 'up-to-date' }
  | { status: 'dirty' }
  | { status: 'merging' }
  | { status: 'skipped' }
  | { status: 'conflicts'; files: string[] }
  | { status: 'failed'; error: string };

function errorText(error: unknown): string {
  const { stderr, stdout } = error as { stderr?: string; stdout?: string };
  return String(stderr || stdout || (error instanceof Error ? error.message : error)).trim();
}

/**
 * Merge `ref` into the branch checked out in `worktreePath`: only when the worktree has no
 * uncommitted changes (Workbench's data folder aside) and no merge in progress. Conflicts are
 * undone (`git merge --abort`), so the worktree stays as it was. `canMerge` is asked right before
 * the merge; false skips it. Never pushes.
 */
export async function pullIntoWorktree(params: {
  worktreePath: string;
  ref: string;
  dataDir?: string;
  canMerge?: () => boolean;
}): Promise<WorktreePullResult> {
  const { worktreePath, ref } = params;
  const run = async (args: string[]) =>
    (await git(args, { cwd: worktreePath, isolated: true, encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 })).stdout;
  const dataDir = `${(params.dataDir || '.workbench').replace(/\\/g, '/')}/`;
  try {
    if (await run(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false)) return { status: 'merging' };
    const dirty = (await run(['status', '--porcelain', '--untracked-files=no']))
      .split('\n')
      .filter((line) => line.trim() && !line.slice(3).startsWith(dataDir));
    if (dirty.length) return { status: 'dirty' };
    if (await run(['merge-base', '--is-ancestor', ref, 'HEAD']).then(() => true, () => false)) return { status: 'up-to-date' };
  } catch (error) {
    return { status: 'failed', error: errorText(error) };
  }
  if (params.canMerge && !params.canMerge()) return { status: 'skipped' };
  try {
    await run(['merge', '--no-edit', ref]);
    return { status: 'merged' };
  } catch (error) {
    const files = (await run(['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n').map((line) => line.trim()).filter(Boolean);
    // Leave the worktree exactly as it was
    await run(['merge', '--abort']).catch(() => undefined);
    return files.length ? { status: 'conflicts', files } : { status: 'failed', error: errorText(error) };
  }
}

// =============================================================================
// After a merge
// =============================================================================

export interface MergeSyncOptions {
  /** Queue a `[Workbench]` notice for a task (batched by the notices) */
  queueNotice: (projectId: string, specId: string, text: string) => void;
  /** Whether the task's run is active (the AgentManager in the app) */
  isRunning?: (projectId: string, task: Task) => boolean;
  /** The repository's default branch, for tasks and projects that name none */
  defaultBranch?: (project: Project) => Promise<string>;
}

function quoteTitle(title: string | undefined): string {
  return title ? ` "${title.replace(/"/g, "'")}"` : '';
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_LISTED);
  const more = files.length > shown.length ? ` and ${files.length - shown.length} more` : '';
  return `${shown.map((file) => `\`${file}\``).join(', ')}${more}`;
}

interface MergeEvent {
  project: Project;
  merged: Pick<Task, 'specId' | 'title'>;
  /** Short description of the merged task, as notices name tasks */
  who: string;
  info: TaskMergeInfo;
  files: string[];
}

/** Tells the other tasks about a merge and brings the ones on the same base branch up to date */
export class MergeSync {
  /** Pulls per project, one after another */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly options: MergeSyncOptions) {}

  /** Wait for every scheduled pull (tests, shutdown) */
  async flush(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** The task's base branch: its own, the project's main branch, else the repository default */
  async baseOf(project: Project, task: Task | undefined, defaultBranch?: () => Promise<string | undefined>): Promise<string> {
    return normalizeBranch(task?.metadata?.baseBranch)
      || normalizeBranch(project.settings?.mainBranch)
      || normalizeBranch(await (defaultBranch ? defaultBranch() : this.defaultBranchOf(project)))
      || 'main';
  }

  private async defaultBranchOf(project: Project): Promise<string | undefined> {
    return this.options.defaultBranch?.(project).catch(() => undefined);
  }

  /** Whether the task runs now, or is between the steps of a run */
  running(projectId: string, task: Task): boolean {
    return RUNNING_STATUSES.has(task.status) || isTaskLive(projectId, task.specId) || (this.options.isRunning?.(projectId, task) ?? false);
  }

  /** A task was merged: notify the others, and pull it into the ones based on that branch */
  async onMerged(event: MergeEvent): Promise<void> {
    const { project, info } = event;
    const env = getTaskMessagingEnv();
    const recipients = (env?.getTasks(project.id) ?? []).filter((t) =>
      t.specId !== event.merged.specId
      && MERGE_RECIPIENT_STATUSES.has(t.status)
      && !t.metadata?.archivedAt
      && t.metadata?.prState !== 'merged');
    if (recipients.length === 0) return;

    // The repository default is looked up at most once per merge
    let fallback: Promise<string | undefined> | undefined;
    const defaultBranch = () => (fallback ??= this.defaultBranchOf(project));
    const same: Task[] = [];
    for (const task of recipients) {
      const base = await this.baseOf(project, task, defaultBranch);
      if (base === info.into) {
        same.push(task);
      } else {
        this.options.queueNotice(project.id, task.specId,
          `${event.who} was merged into \`${info.into}\`. That is not your base branch (\`${base}\`), so there is nothing to pull.`);
      }
    }
    if (same.length === 0) return;

    const { ref, fetchNote } = await this.mergedRef(project, info);
    for (const task of same) {
      if (this.running(project.id, task)) {
        this.options.queueNotice(project.id, task.specId, this.mergeNowText(event, ref, fetchNote));
      } else {
        this.enqueue(project.id, () => this.pull(event, task.specId, ref, fetchNote));
      }
    }
  }

  /** Where the merge can be read: the local branch, or the remote one after a fetch for a PR */
  private async mergedRef(project: Project, info: TaskMergeInfo): Promise<{ ref: string; fetchNote?: string }> {
    if (info.via !== 'pr') return { ref: info.into };
    try {
      await git(['fetch', 'origin', info.into], { cwd: project.path, isolated: true, encoding: 'utf-8', timeout: 120_000 });
      return { ref: `origin/${info.into}` };
    } catch (error) {
      appLog.warn(`[MergeSync] Could not fetch origin/${info.into} in ${project.path}, using the local branch: ${errorText(error)}`);
      return {
        ref: info.into,
        fetchNote: `Workbench could not fetch \`origin/${info.into}\`, so this is your local \`${info.into}\`, which may not include the merge yet.`,
      };
    }
  }

  private mergeNowText(event: MergeEvent, ref: string, fetchNote?: string): string {
    const { info, files } = event;
    return [
      `${event.who} was merged into \`${info.into}\`, your base branch.${files.length ? ` It changed ${listFiles(files)}.` : ''}`,
      `Merge it into your branch now: commit your work in progress, run \`git merge --no-edit ${ref}\`, resolve any conflicts keeping both sides' intent, re-run the checks for what changed, and commit.`,
      'If you are in a read-only planning step, do this at the start of implementation.',
      fetchNote,
    ].filter(Boolean).join(' ');
  }

  private enqueue(projectId: string, job: () => Promise<void>): void {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(job).catch((error) => {
      appLog.warn(`[MergeSync] A pull failed: ${errorText(error)}`);
    });
    this.chains.set(projectId, next);
    void next.finally(() => {
      if (this.chains.get(projectId) === next) this.chains.delete(projectId);
    });
  }

  /** Merge `ref` into a task's worktree while the task is not running */
  private async pull(event: MergeEvent, specId: string, ref: string, fetchNote?: string): Promise<void> {
    const { project, info, merged } = event;
    const task = getTaskMessagingEnv()?.getTasks(project.id).find((t) => t.specId === specId);
    if (!task || !MERGE_RECIPIENT_STATUSES.has(task.status) || task.metadata?.archivedAt) return;
    if (this.running(project.id, task)) {
      this.options.queueNotice(project.id, specId, this.mergeNowText(event, ref, fetchNote));
      return;
    }
    const worktreePath = findTaskWorktree(project.path, specId);
    if (!worktreePath) return;
    if (isTaskBranchBusy(task.id)) {
      appLog.info(`[MergeSync] ${specId} is being merged, ${ref} is not pulled into it`);
      return;
    }

    // A run starting meanwhile waits for this pull to end (AgentManager calls waitForBranchSync)
    const result: WorktreePullResult = await runBranchSync(task.id, () => pullIntoWorktree({
      worktreePath,
      ref,
      dataDir: project.autoBuildPath,
      // Re-checked right before the merge: the task may have started meanwhile
      canMerge: () => {
        const current = getTaskMessagingEnv()?.getTasks(project.id).find((t) => t.specId === specId) ?? task;
        return !this.running(project.id, current);
      },
    }));

    const mergedTask = `task ${merged.specId}${quoteTitle(merged.title)}`;
    switch (result.status) {
      case 'merged': {
        const text = `\`${info.into}\` was merged into your branch after ${mergedTask} was merged into it.${event.files.length ? ` It changed ${listFiles(event.files)}.` : ''}`;
        this.taskLog(project, specId, `Merged ${ref} into this task's branch after ${mergedTask} was merged`);
        await deliverToTask(project.id, task, { kind: 'workbench' }, text);
        return;
      }
      case 'conflicts': {
        const text = `${mergedTask} was merged into \`${info.into}\`, your base branch. It conflicts with your branch in ${listFiles(result.files)}, so Workbench did not merge it; the conflicts will be resolved when this task is merged.`;
        this.taskLog(project, specId, `${mergedTask} was merged into ${info.into}: conflicts with ${info.into} in ${result.files.join(', ')}; they will be resolved when this task is merged`);
        await deliverToTask(project.id, task, { kind: 'workbench' }, text);
        return;
      }
      case 'dirty': {
        const text = `${mergedTask} was merged into \`${info.into}\`, your base branch. Your worktree has uncommitted changes, so Workbench did not merge it: when you run again, commit your work, run \`git merge --no-edit ${ref}\`, resolve any conflicts and commit.`;
        await deliverToTask(project.id, task, { kind: 'workbench' }, text);
        return;
      }
      case 'skipped':
        this.options.queueNotice(project.id, specId, this.mergeNowText(event, ref, fetchNote));
        return;
      case 'failed':
        appLog.warn(`[MergeSync] Could not merge ${ref} into ${specId}: ${result.error}`);
        this.taskLog(project, specId, `Could not merge ${ref} into this task's branch after ${mergedTask} was merged`, result.error);
        return;
      default:
        // Up to date, or a merge in progress there: nothing to do
        return;
    }
  }

  private taskLog(project: Project, specId: string, content: string, detail?: string): void {
    try {
      const log = new TaskLogWriter(taskSpecDir(project, specId), specId);
      log.add('coding', 'info', content, detail ? { detail } : {});
      log.saveNow();
    } catch (error) {
      appLog.warn(`[MergeSync] Could not write the task log of ${specId}: ${errorText(error)}`);
    }
  }
}
