/**
 * Workbench notices
 * =================
 *
 * Short `[Workbench]` messages the broker sends on its own, so parallel tasks know about each
 * other without asking. Driven by the task hooks (`state`, `files-edited`) and the project's task
 * changelog (which files each task changes):
 *
 * - a task started                      -> the other active tasks
 * - two tasks change the same files     -> both (once per pair and file)
 * - a task finished (Human Review)      -> active tasks that change the same files
 * - a task was merged                   -> every other unfinished task; the ones based on the branch
 *                                          it was merged into take it in (`merge-sync.ts`)
 *
 * Notices are batched per target for a few seconds and deduplicated. The same transitions are
 * offered as lifecycle events (`onTaskLifecycle`) for the project lead.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import type { Project, Task, TaskStatus } from '../../shared/types';
import { getTaskWorktreeBranch } from '../../shared/utils/claude-run';
import { taskSessionName } from '../../shared/utils/task-messaging';
import { taskHooks, type TaskHookEvents } from '../task-hooks';
import { foldTaskChangelog, getTaskChangelogPath, readTaskChangelog, type TaskChangelogTask } from '../task-changelog';
import { deliverToTask, getTaskMessagingEnv, taskSpecDir } from './broker';
import { MergeSync, takeTaskMerge, type MergeSyncOptions, type MergeVia, type TaskMergeInfo } from './merge-sync';

/** Tasks that get notices: running, reviewed by AI, or waiting in the queue (their inbox) */
const RECIPIENT_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review']);
/** Tasks whose changes are not merged yet */
const UNMERGED_STATUSES = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review', 'human_review', 'pr_created', 'error']);
const MAX_FILES_LISTED = 10;
const MAX_SUMMARY = 300;

export type TaskLifecycleKind = 'started' | 'finished' | 'merged' | 'done' | 'failed';

/** A task's lifecycle step, for the project lead */
export interface TaskLifecycleEvent {
  kind: TaskLifecycleKind;
  projectId: string;
  specId: string;
  title: string;
  sessionName: string;
  /** Files its branch changes (as the changelog and its edits know them) */
  files: string[];
  /** finished: its summary */
  summary?: string;
  /** merged: the branch it was merged into; done: its base branch */
  baseBranch?: string;
  /** merged: locally or through its pull request */
  mergedVia?: MergeVia;
}

export interface TaskNoticesOptions {
  /** How long notices for one target are collected before they are sent */
  batchMs?: number;
  /** How long a task's edits are collected before overlaps are checked */
  editBatchMs?: number;
  /** Whether a task that entered Done was merged into its base branch */
  isMerged?: (project: Project, task: Task, branch: string | undefined, base: string) => Promise<boolean>;
  /** Whether notices are on now (Settings > Agents) */
  isEnabled?: () => boolean;
  /** Whether a task's run is active (the AgentManager in the app) */
  isRunning?: MergeSyncOptions['isRunning'];
  /** The repository's default branch, for tasks and projects that name none */
  defaultBranch?: MergeSyncOptions['defaultBranch'];
}

const lifecycleHandlers = new Set<(event: TaskLifecycleEvent) => void>();

/** Listen to task lifecycle steps (started, finished, merged, done, failed); returns an unsubscribe */
export function onTaskLifecycle(handler: (event: TaskLifecycleEvent) => void): () => void {
  lifecycleHandlers.add(handler);
  return () => {
    lifecycleHandlers.delete(handler);
  };
}

function emitLifecycle(event: TaskLifecycleEvent): void {
  for (const handler of lifecycleHandlers) {
    try {
      handler(event);
    } catch {
      // A failing listener never affects the notices
    }
  }
}

function describe(projectId: string, task: Pick<Task, 'specId' | 'title'>): string {
  const title = task.title ? ` "${task.title.replace(/"/g, "'")}"` : '';
  return `Task ${task.specId}${title} (session ${taskSessionName(projectId, task.specId)})`;
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, MAX_FILES_LISTED);
  const more = files.length > shown.length ? ` and ${files.length - shown.length} more` : '';
  return `${shown.map((file) => `\`${file}\``).join(', ')}${more}`;
}

const key = (projectId: string, specId: string) => `${projectId}\u0000${specId}`;

/** Batched, deduplicated notices for the tasks of all projects */
export class TaskNotices {
  private readonly batchMs: number;
  private readonly editBatchMs: number;
  private readonly lastStatus = new Map<string, TaskStatus>();
  /** Files each task edited while the app ran (the changelog may not have them yet) */
  private readonly edited = new Map<string, Set<string>>();
  private readonly pendingEdits = new Map<string, { project: Project; files: Map<string, Set<string>>; timer: ReturnType<typeof setTimeout> }>();
  /** `<project>\0<a>\0<b>\0<file>` (a < b): overlaps already announced */
  private readonly announcedOverlaps = new Set<string>();
  private readonly batches = new Map<string, { projectId: string; specId: string; lines: string[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: Array<() => void> = [];
  private readonly mergeSync: MergeSync;

  constructor(private readonly options: TaskNoticesOptions = {}) {
    this.batchMs = options.batchMs ?? 3000;
    this.editBatchMs = options.editBatchMs ?? 1000;
    this.mergeSync = new MergeSync({
      queueNotice: (projectId, specId, text) => this.queueNotice(projectId, specId, text),
      isRunning: options.isRunning,
      defaultBranch: options.defaultBranch,
    });
  }

  /** Listen to the task hooks */
  start(): this {
    this.unsubscribe.push(
      taskHooks.on('state', (event) => this.onState(event)),
      taskHooks.on('files-edited', (event) => this.onFilesEdited(event)),
    );
    return this;
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const pending of this.pendingEdits.values()) clearTimeout(pending.timer);
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.pendingEdits.clear();
    this.batches.clear();
  }

  /** Send every collected notice now and wait for it (tests, shutdown) */
  async flush(): Promise<void> {
    await Promise.all([...this.pendingEdits.keys()].map((projectId) => this.checkOverlaps(projectId)));
    await this.mergeSync.flush();
    await Promise.all([...this.batches.keys()].map((target) => this.sendBatch(target)));
  }

  private enabled(): boolean {
    return this.options.isEnabled?.() ?? true;
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  async onState({ project, task, status, state }: TaskHookEvents['state']): Promise<void> {
    const taskKey = key(project.id, task.specId);
    const previous = this.lastStatus.get(taskKey);
    this.lastStatus.set(taskKey, status);
    if (previous === status) return;

    if (status === 'in_progress') {
      const fresh = previous === 'backlog' || previous === 'queue' || (previous === undefined && (!state || state === 'planning'));
      if (!fresh) return;
      const files = await this.filesOf(project, task.specId);
      emitLifecycle({ kind: 'started', projectId: project.id, specId: task.specId, title: task.title, sessionName: taskSessionName(project.id, task.specId), files });
      if (!this.enabled()) return;
      for (const other of this.recipients(project.id, task.specId)) {
        this.queueNotice(project.id, other.specId, `${describe(project.id, task)} started.`);
      }
      return;
    }

    if (status === 'human_review' && state === 'error') {
      emitLifecycle({
        kind: 'failed', projectId: project.id, specId: task.specId, title: task.title,
        sessionName: taskSessionName(project.id, task.specId), files: await this.filesOf(project, task.specId),
      });
      return;
    }

    if (status === 'human_review' && previous !== 'pr_created') {
      const run = await this.runOf(project, task.specId);
      // A stopped run waits for the user too, but it didn't finish anything
      if (run.stopped) return;
      const files = await this.filesOf(project, task.specId);
      const { summary } = run;
      emitLifecycle({ kind: 'finished', projectId: project.id, specId: task.specId, title: task.title, sessionName: taskSessionName(project.id, task.specId), files, summary });
      if (!this.enabled()) return;
      await this.notifyOverlapping(project, task, files, (shared) =>
        `${describe(project.id, task)} finished and waits for review (not merged yet). It changes files you also change: ${listFiles(shared)}.${summary ? ` Its summary: ${summary}` : ''}`);
      return;
    }

    if (status === 'done') {
      const files = await this.filesOf(project, task.specId);
      const merge = await this.mergeOf(project, task);
      emitLifecycle({
        kind: merge ? 'merged' : 'done', projectId: project.id, specId: task.specId, title: task.title,
        sessionName: taskSessionName(project.id, task.specId), files,
        baseBranch: merge?.into ?? await this.mergeSync.baseOf(project, task),
        ...(merge ? { mergedVia: merge.via } : {}),
      });
      this.edited.delete(key(project.id, task.specId));
      if (!merge || !this.enabled()) return;
      await this.mergeSync.onMerged({ project, merged: task, who: describe(project.id, task), info: merge, files });
      return;
    }

    if (status === 'error') {
      emitLifecycle({
        kind: 'failed', projectId: project.id, specId: task.specId, title: task.title,
        sessionName: taskSessionName(project.id, task.specId), files: await this.filesOf(project, task.specId),
      });
    }
  }

  onFilesEdited({ project, task, files }: TaskHookEvents['files-edited']): void {
    if (files.length === 0) return;
    const own = this.edited.get(key(project.id, task.specId)) ?? new Set<string>();
    for (const file of files) own.add(file);
    this.edited.set(key(project.id, task.specId), own);
    if (!this.enabled()) return;
    let pending = this.pendingEdits.get(project.id);
    if (!pending) {
      pending = { project, files: new Map(), timer: setTimeout(() => void this.checkOverlaps(project.id), this.editBatchMs) };
      this.pendingEdits.set(project.id, pending);
    }
    const set = pending.files.get(task.specId) ?? new Set<string>();
    for (const file of files) set.add(file);
    pending.files.set(task.specId, set);
  }

  // ---------------------------------------------------------------------------
  // Overlaps
  // ---------------------------------------------------------------------------

  private async checkOverlaps(projectId: string): Promise<void> {
    const pending = this.pendingEdits.get(projectId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingEdits.delete(projectId);
    const env = getTaskMessagingEnv();
    if (!env) return;
    const { project } = pending;
    const tasks = env.getTasks(projectId).filter((t) => !t.metadata?.archivedAt);
    const fold = await this.fold(project);

    for (const [editorId, editedFiles] of pending.files) {
      const editor = tasks.find((t) => t.specId === editorId);
      if (!editor) continue;
      for (const other of tasks) {
        if (other.specId === editorId || !UNMERGED_STATUSES.has(other.status)) continue;
        const theirs = this.filesFrom(fold.get(other.specId), projectId, other.specId);
        const pair = [editorId, other.specId].sort().join('\u0000');
        const shared = [...editedFiles].filter((file) => theirs.has(file) && !this.announcedOverlaps.has(`${projectId}\u0000${pair}\u0000${file}`)).sort();
        if (shared.length === 0) continue;
        for (const file of shared) this.announcedOverlaps.add(`${projectId}\u0000${pair}\u0000${file}`);
        if (RECIPIENT_STATUSES.has(editor.status)) {
          this.queueNotice(projectId, editorId,
            `${describe(projectId, other)} also changes files you are editing: ${listFiles(shared)}. Check list_parallel_tasks, and use message_task if your changes interact.`);
        }
        if (RECIPIENT_STATUSES.has(other.status)) {
          this.queueNotice(projectId, other.specId, `${describe(projectId, editor)} is editing files you also change: ${listFiles(shared)}.`);
        }
      }
    }
  }

  /**
   * Where a task that entered Done was merged, and how: as Workbench recorded it, else a merged
   * pull request, else its branch found in its base branch (merged locally); undefined: not merged
   */
  private async mergeOf(project: Project, task: Task): Promise<TaskMergeInfo | undefined> {
    const recorded = takeTaskMerge(project.id, task.specId);
    if (recorded) return recorded;
    const env = getTaskMessagingEnv();
    const current = env?.getTasks(project.id).find((t) => t.specId === task.specId) ?? task;
    const base = await this.mergeSync.baseOf(project, current);
    if (current.metadata?.prState === 'merged' || task.metadata?.prState === 'merged') return { into: base, via: 'pr' };
    const fold = await this.fold(project);
    return (await this.isMerged(project, current, fold.get(task.specId)?.branch, base)) ? { into: base, via: 'local' } : undefined;
  }

  /** Notify the active tasks whose files overlap `files` */
  private async notifyOverlapping(project: Project, task: Task, files: string[], text: (shared: string[]) => string): Promise<void> {
    if (files.length === 0) return;
    const fold = await this.fold(project);
    const mine = new Set(files);
    for (const other of this.recipients(project.id, task.specId)) {
      const shared = [...this.filesFrom(fold.get(other.specId), project.id, other.specId)].filter((file) => mine.has(file)).sort();
      if (shared.length > 0) this.queueNotice(project.id, other.specId, text(shared));
    }
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  private queueNotice(projectId: string, specId: string, line: string): void {
    const target = key(projectId, specId);
    let batch = this.batches.get(target);
    if (!batch) {
      batch = { projectId, specId, lines: [], timer: setTimeout(() => void this.sendBatch(target), this.batchMs) };
      this.batches.set(target, batch);
    }
    if (!batch.lines.includes(line)) batch.lines.push(line);
  }

  private async sendBatch(target: string): Promise<void> {
    const batch = this.batches.get(target);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(target);
    const env = getTaskMessagingEnv();
    const task = env?.getTasks(batch.projectId).find((t) => t.specId === batch.specId);
    if (!task || batch.lines.length === 0) return;
    const text = batch.lines.length === 1
      ? batch.lines[0]
      : `Updates on parallel tasks:\n${batch.lines.map((line) => `- ${line}`).join('\n')}`;
    await deliverToTask(batch.projectId, task, { kind: 'workbench' }, text);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Other tasks of the project that get notices now */
  private recipients(projectId: string, specId: string): Task[] {
    const env = getTaskMessagingEnv();
    return (env?.getTasks(projectId) ?? []).filter(
      (t) => t.specId !== specId && RECIPIENT_STATUSES.has(t.status) && !t.metadata?.archivedAt
    );
  }

  private async fold(project: Project): Promise<Map<string, TaskChangelogTask>> {
    if (!project.autoBuildPath) return new Map();
    return foldTaskChangelog(await readTaskChangelog(getTaskChangelogPath(project.path, project.autoBuildPath)));
  }

  private filesFrom(entry: TaskChangelogTask | undefined, projectId: string, specId: string): Set<string> {
    return new Set([...(entry?.files ?? []), ...(this.edited.get(key(projectId, specId)) ?? [])]);
  }

  private async filesOf(project: Project, specId: string): Promise<string[]> {
    const fold = await this.fold(project);
    return [...this.filesFrom(fold.get(specId), project.id, specId)].sort();
  }

  /** The task's summary and whether its run was stopped, from its `claude_run.json` */
  private async runOf(project: Project, specId: string): Promise<{ summary?: string; stopped: boolean }> {
    try {
      const info = JSON.parse(await readFile(path.join(taskSpecDir(project, specId), 'claude_run.json'), 'utf-8')) as {
        summary?: string;
        validation?: { summary?: string };
        phases?: Array<{ isError?: boolean; error?: string }>;
      };
      const last = info.phases?.at(-1);
      const stopped = last?.isError === true && last.error === 'Stopped';
      const text = (info.validation?.summary || info.summary || '').replace(/\s+/g, ' ').trim();
      const summary = text ? (text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text) : undefined;
      return { summary, stopped };
    } catch {
      return { stopped: false };
    }
  }

  private async isMerged(project: Project, task: Task, branch: string | undefined, base: string): Promise<boolean> {
    if (!this.options.isMerged) return false;
    try {
      return await this.options.isMerged(project, task, branch ?? getTaskWorktreeBranch(task.specId), base);
    } catch {
      return false;
    }
  }
}
