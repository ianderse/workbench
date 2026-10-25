/**
 * Notification events: the text, the click route and the timing rules for the notifications that
 * matter in the autonomous workflow (task merged, decision needed, needs attention, all work done).
 *
 * Pure (no Electron, timers only through an injectable scheduler), so it is tested directly.
 * `main/attention-notifier.ts` connects it to the task hooks and `notification-service.ts`.
 */
import type { Task, TaskStatus } from '../types';

/** Which switch in Settings > General > Notifications governs a notification */
export type NotificationKind =
  | 'task-complete'
  | 'task-failed'
  | 'review-needed'
  | 'decision-needed'
  | 'queue-empty';

/** Where a click on the notification goes: a task's detail, or the project's board */
export interface NotificationRoute {
  projectId: string;
  taskId?: string;
}

export interface NotificationContent {
  kind: NotificationKind;
  title: string;
  body: string;
  route: NotificationRoute;
}

type TaskRef = Pick<Task, 'id' | 'title' | 'specId'>;

const MAX_BODY_TITLES = 3;

const taskName = (task: TaskRef): string => `"${task.title || task.specId}"`;

/** An autonomous merge: "Task merged" with the branch it went into */
export function taskMergedContent(projectId: string, task: TaskRef, branch: string): NotificationContent {
  return {
    kind: 'task-complete',
    title: 'Task merged',
    body: `${taskName(task)} was merged into ${branch}`,
    route: { projectId, taskId: task.id },
  };
}

/** A task moved to Done by a merge (local merge, merged pull request) */
export function taskDoneContent(projectId: string, task: TaskRef): NotificationContent {
  return {
    kind: 'task-complete',
    title: 'Task merged',
    body: `${taskName(task)} was merged and is done`,
    route: { projectId, taskId: task.id },
  };
}

export type NeedsAttentionReason = 'auto-merge-blocked' | 'resume-failed' | 'error';

/** A task the workflow cannot continue without the person */
export function needsAttentionContent(
  projectId: string,
  task: TaskRef,
  reason: NeedsAttentionReason,
  detail?: string
): NotificationContent {
  const body =
    reason === 'auto-merge-blocked'
      ? `${taskName(task)} could not be merged automatically${detail ? `: ${detail}` : ''}`
      : reason === 'resume-failed'
        ? `${taskName(task)} was interrupted and could not be resumed`
        : `${taskName(task)} stopped with an error`;
  return { kind: 'task-failed', title: 'Needs attention', body, route: { projectId, taskId: task.id } };
}

export interface DecisionTicket {
  taskId: string;
  title: string;
}

/** One ticket opens that ticket; several open the board (the decisions are in Planning) */
export function decisionNeededContent(projectId: string, tickets: DecisionTicket[]): NotificationContent | null {
  if (tickets.length === 0) return null;
  if (tickets.length === 1) {
    return {
      kind: 'decision-needed',
      title: `Decision needed: ${tickets[0].title}`,
      body: 'A follow-up ticket is waiting for your decision',
      route: { projectId, taskId: tickets[0].taskId },
    };
  }
  const shown = tickets
    .slice(0, MAX_BODY_TITLES)
    .map((t) => `"${t.title}"`)
    .join(', ');
  const more = tickets.length > MAX_BODY_TITLES ? ` and ${tickets.length - MAX_BODY_TITLES} more` : '';
  return {
    kind: 'decision-needed',
    title: `Decisions needed: ${tickets.length} tickets`,
    body: `${shown}${more}`,
    route: { projectId },
  };
}

/** Board statuses that mean work is still going on */
const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['queue', 'in_progress', 'ai_review']);

export function hasActiveWork(tasks: Array<Pick<Task, 'status' | 'metadata'>>): boolean {
  return tasks.some((t) => ACTIVE_STATUSES.has(t.status) && !t.metadata?.archivedAt);
}

/** Tickets that wait for the person: Human Review not yet merged, and open decision tickets */
export function countWaiting(tasks: Array<Pick<Task, 'status' | 'reviewReason' | 'metadata'>>): number {
  return tasks.filter((t) => {
    if (t.metadata?.archivedAt) return false;
    if (t.status === 'human_review') return t.reviewReason !== 'auto_merged';
    return !!t.metadata?.followUpFrom?.needsDecision && !t.metadata?.decision && t.status !== 'done';
  }).length;
}

export function queueEmptyContent(projectId: string, projectName: string, merged: number, waiting: number): NotificationContent {
  return {
    kind: 'queue-empty',
    title: `All tasks finished in ${projectName}`,
    body: `${merged} merged, ${waiting} waiting for review or decision`,
    route: { projectId },
  };
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Detects "a project's board went from having active work to none". It only counts as a finish after
 * work was seen active in this session (nothing fires at app start) and the board stayed idle for
 * `debounceMs` (a task moving from the queue to In Progress passes through a moment with no active
 * task). `isIdle` is asked again when the timer fires, so a late change cancels the notification.
 */
export class QueueEmptyTracker {
  private readonly seenActive = new Set<string>();
  private readonly merged = new Map<string, number>();
  private readonly timers = new Map<string, unknown>();

  constructor(
    private readonly onFinished: (projectId: string, merged: number) => void,
    private readonly isIdle: (projectId: string) => boolean,
    private readonly debounceMs = 5000,
    private readonly scheduler: Scheduler = realScheduler
  ) {}

  /** Tell the tracker whether the project has active work right now */
  observe(projectId: string, active: boolean): void {
    if (active) {
      this.seenActive.add(projectId);
      this.cancel(projectId);
      return;
    }
    if (!this.seenActive.has(projectId) || this.timers.has(projectId)) return;
    this.timers.set(
      projectId,
      this.scheduler.set(() => {
        this.timers.delete(projectId);
        if (!this.seenActive.has(projectId) || !this.isIdle(projectId)) return;
        const merged = this.merged.get(projectId) ?? 0;
        this.seenActive.delete(projectId);
        this.merged.delete(projectId);
        this.onFinished(projectId, merged);
      }, this.debounceMs)
    );
  }

  /** A task of the project was merged (counted in the next "all work done" notification) */
  recordMerge(projectId: string): void {
    this.merged.set(projectId, (this.merged.get(projectId) ?? 0) + 1);
  }

  private cancel(projectId: string): void {
    const handle = this.timers.get(projectId);
    if (handle === undefined) return;
    this.scheduler.clear(handle);
    this.timers.delete(projectId);
  }
}

/** Collects the decision tickets created within `windowMs` for a project into one notification */
export class DecisionBatcher {
  private readonly pending = new Map<string, DecisionTicket[]>();
  private readonly timers = new Map<string, unknown>();

  constructor(
    private readonly flush: (projectId: string, tickets: DecisionTicket[]) => void,
    private readonly windowMs = 2000,
    private readonly scheduler: Scheduler = realScheduler
  ) {}

  add(projectId: string, tickets: DecisionTicket[]): void {
    if (tickets.length === 0) return;
    this.pending.set(projectId, [...(this.pending.get(projectId) ?? []), ...tickets]);
    if (this.timers.has(projectId)) return;
    this.timers.set(
      projectId,
      this.scheduler.set(() => {
        this.timers.delete(projectId);
        const batch = this.pending.get(projectId) ?? [];
        this.pending.delete(projectId);
        if (batch.length > 0) this.flush(projectId, batch);
      }, this.windowMs)
    );
  }
}
