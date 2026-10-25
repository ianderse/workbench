/**
 * Merge sync
 * ==========
 *
 * When a task is merged, every other unfinished task of the project hears about it (In Progress,
 * AI Review, Human Review, PR Created, Error; no file filter), and the ones based on the branch
 * it was merged into take the change in. Each of those whose worktree branch lacks the merge gets a
 * resync request (`task-resync/request.ts`; several merges coalesce into one that merges every ref):
 *
 * - running (its run is live, or it is In Progress / AI Review): a `[Workbench]` notice tells it
 *   to merge that branch now (live stdin, or the inbox for its next step). Should the run end
 *   without doing it, the request is still there and the resync service takes over;
 * - waiting in the Queue (a rate-limit hold): the request only; its run applies it when it resumes;
 * - not running (Human Review for any reason, Error, PR Created after a merged PR): the resync
 *   service (`requestResync`) moves it back to In Progress, where its own session merges the
 *   branch and resumes its work, then validates (`task-resync/`);
 * - with a pull request, after a local merge: an informational notice only. The local branch has
 *   commits that are not pushed, and the task's next push would carry them into its pull request;
 * - being merged itself right now: nothing (its branch is about to land in the base branch);
 * - based on another branch: an informational notice.
 *
 * The merged ref: a local merge's `<base>`; a merged PR's `origin/<base>` after one fetch in the
 * project (the local `<base>` when the fetch fails, then treated as a local merge: not for tasks with
 * a pull request). Checks run one task at a time per project.
 */
import type { Project, Task, TaskStatus } from '../../shared/types';
import { appLog } from '../app-logger';
import { git } from '../utils/git-exec';
import { findTaskWorktree } from '../worktree-paths';
import { isTaskBranchMerging } from '../worktree/merge-guard';
import { keepsLocalMergeOut as keepsLocalResyncOut, recordResyncRequest } from '../task-resync/request';
import { getTaskMessagingEnv, isTaskLive, taskSpecDir } from './broker';

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

/** Whether a merge is recorded for the task (not taken yet) */
export function hasTaskMerge(projectId: string, specId: string): boolean {
  const entry = recorded.get(recordKey(projectId, specId));
  return !!entry && Date.now() - entry.at <= RECORD_TTL_MS;
}

/** The merge recorded for a task that just entered Done (once) */
export function takeTaskMerge(projectId: string, specId: string): TaskMergeInfo | undefined {
  const key = recordKey(projectId, specId);
  const entry = recorded.get(key);
  recorded.delete(key);
  if (!entry || Date.now() - entry.at > RECORD_TTL_MS) return undefined;
  return { into: entry.into, via: entry.via };
}

/**
 * Whether `branch` has commits of its own (it moved on from the commit it was created at, as its
 * reflog has it) and all of them are in `base`. A branch with no commits is in its base branch
 * without having been merged
 */
export async function isBranchMergedInto(projectPath: string, branch: string, base: string): Promise<boolean> {
  const run = async (args: string[]) =>
    (await git(args, { cwd: projectPath, isolated: true, encoding: 'utf-8', timeout: 15000 })).stdout.trim();
  try {
    const tip = await run(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
    await run(['merge-base', '--is-ancestor', tip, base]);
    const created = (await run(['log', '-g', '--format=%H', `refs/heads/${branch}`]).catch(() => '')).split('\n').filter(Boolean).at(-1);
    // Without a reflog (turned off) there is no telling: the branch being in its base counts
    return !created || created !== tip;
  } catch {
    return false;
  }
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
    const files = (await run(['diff', '--no-color', '--no-ext-diff', '--name-only', '-z', '--diff-filter=U']).catch(() => ''))
      .split('\0').filter(Boolean);
    // Leave the worktree exactly as it was
    await run(['merge', '--abort']).catch(() => undefined);
    return files.length ? { status: 'conflicts', files } : { status: 'failed', error: errorText(error) };
  }
}

// =============================================================================
// After a merge
// =============================================================================

export interface MergeSyncOptions {
  /** Queue a `[Workbench]` notice for a task (batched by the notices; dropped while they are off) */
  queueNotice: (projectId: string, specId: string, text: string) => void;
  /** Whether the task's run is active (the AgentManager in the app) */
  isRunning?: (projectId: string, task: Task) => boolean;
  /** The repository's default branch, for tasks and projects that name none */
  defaultBranch?: (project: Project) => Promise<string>;
  /** A task that is not running got a resync request: bring it back to In Progress to apply it */
  requestResync?: (project: Project, task: Task) => void;
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_LISTED);
  const more = files.length > shown.length ? ` and ${files.length - shown.length} more` : '';
  return `${shown.map((file) => `\`${file}\``).join(', ')}${more}`;
}

/**
 * A local merge pushes nothing, so the local base branch is kept out of a task with a pull
 * request: Merge PR pushes the task's branch, which would carry those commits into the PR
 */
export function keepsLocalMergeOut(info: { via: MergeVia }, task: Task): boolean {
  return keepsLocalResyncOut(info, task);
}

interface MergeEvent {
  project: Project;
  merged: Pick<Task, 'specId' | 'title'>;
  /** Short description of the merged task, as notices name tasks */
  who: string;
  info: TaskMergeInfo;
  files: string[];
  /** A merged PR whose `origin/<base>` could not be fetched: the local base branch stands in */
  fetchFailed?: boolean;
}

/** Tells the other tasks about a merge and has the ones on the same base branch take it in */
export class MergeSync {
  /** Checks per project, one after another */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly options: MergeSyncOptions) {}

  /** Wait for every scheduled check (tests, shutdown) */
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

  /** A task was merged: notify the others, and have the ones based on that branch take it in */
  async onMerged(event: MergeEvent): Promise<void> {
    const { project, info } = event;
    const env = getTaskMessagingEnv();
    const recipients = (env?.getTasks(project.id) ?? []).filter((t) =>
      t.specId !== event.merged.specId
      && (MERGE_RECIPIENT_STATUSES.has(t.status) || t.status === 'queue')
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
      } else if (task.status !== 'queue') {
        this.options.queueNotice(project.id, task.specId,
          `${event.who} was merged into \`${info.into}\`. That is not your base branch (\`${base}\`), so there is nothing to pull.`);
      }
    }
    if (same.length === 0) return;

    const { ref, fetchNote } = await this.mergedRef(project, info);
    // Without the fetch the ref is the local base branch, with its unpushed commits: a local merge
    const merge: MergeEvent = fetchNote ? { ...event, info: { ...info, via: 'local' }, fetchFailed: true } : event;
    for (const task of same) {
      if (keepsLocalMergeOut(merge.info, task)) {
        this.options.queueNotice(project.id, task.specId, this.notPushedText(merge));
      } else {
        this.enqueue(project.id, () => this.takeIn(merge, task.specId, ref, fetchNote));
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

  private notPushedText(event: MergeEvent): string {
    const { into } = event.info;
    if (event.fetchFailed) {
      return `${event.who} was merged into \`origin/${into}\`, but Workbench could not fetch it, so it was not merged into your branch: your local \`${into}\` may have commits that are not pushed, and your pull request merges against \`origin/${into}\`.`;
    }
    return `${event.who} was merged into \`${into}\` locally and is not pushed yet, so it was not merged into your branch: your pull request merges against \`origin/${into}\`.`;
  }

  private enqueue(projectId: string, job: () => Promise<void>): void {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(job).catch((error) => {
      appLog.warn(`[MergeSync] Taking in a merge failed: ${errorText(error)}`);
    });
    this.chains.set(projectId, next);
    void next.finally(() => {
      if (this.chains.get(projectId) === next) this.chains.delete(projectId);
    });
  }

  /** Record the resync request of a task on the merged branch, and tell or wake the task */
  private async takeIn(event: MergeEvent, specId: string, ref: string, fetchNote?: string): Promise<void> {
    const { project, info, merged } = event;
    const task = getTaskMessagingEnv()?.getTasks(project.id).find((t) => t.specId === specId);
    if (!task || task.metadata?.archivedAt || task.metadata?.prState === 'merged') return;
    if (!MERGE_RECIPIENT_STATUSES.has(task.status) && task.status !== 'queue') return;
    // It may have got a pull request while it waited
    if (keepsLocalMergeOut(info, task)) {
      this.options.queueNotice(project.id, specId, this.notPushedText(event));
      return;
    }
    // Its own branch is going into the base branch right now
    if (isTaskBranchMerging(project.id, task.id)) {
      appLog.info(`[MergeSync] ${specId} is being merged, ${ref} is not taken into it`);
      return;
    }
    const worktreePath = task.metadata?.useWorktree === false ? null : findTaskWorktree(project.path, specId);
    if (!worktreePath) {
      // Nothing of its own to sync: a running task in the project itself is told; the rest create
      // their worktree from the base branch when they start
      if (this.running(project.id, task)) this.options.queueNotice(project.id, specId, this.mergeNowText(event, ref, fetchNote));
      return;
    }
    const upToDate = await git(['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: worktreePath, isolated: true })
      .then(() => true, () => false);
    if (upToDate) return;

    try {
      recordResyncRequest(taskSpecDir(project, specId), {
        ref,
        into: info.into,
        via: info.via,
        merged: { specId: merged.specId, title: merged.title, files: event.files },
      });
    } catch (error) {
      appLog.warn(`[MergeSync] Could not record the resync request of ${specId}: ${errorText(error)}`);
      return;
    }

    // Re-read: it may have started while its worktree was checked
    const current = getTaskMessagingEnv()?.getTasks(project.id).find((t) => t.specId === specId) ?? task;
    if (this.running(project.id, current)) {
      this.options.queueNotice(project.id, specId, this.mergeNowText(event, ref, fetchNote));
      return;
    }
    // Queued (a rate-limit hold, or waiting for a slot): its run applies the request when it starts
    if (current.status === 'queue') return;
    this.options.requestResync?.(project, current);
  }
}
