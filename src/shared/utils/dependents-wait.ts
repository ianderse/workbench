/**
 * Dependents wait for continuing tickets
 * ======================================
 *
 * A ticket that depends on task S (say "Write the validation report") waits for S only. When S's
 * review later produces follow-up tickets, or a decision ticket on S turns into tickets, that work
 * belongs to the same scope, so a dependent that has not started yet must wait for it too.
 * `addDependencyToDependents()` works out those dependency changes (pure); `main/dependents-wait.ts`
 * persists them. Shared by follow-up tickets and decision tickets; deferred-work splits already
 * rewire their dependents in `applyTaskSplit()`.
 */
import type { Task } from '../types';

/** Statuses a dependent can still be changed in: Planning (backlog) and the Queue */
const WAITING_STATUSES = new Set(['backlog', 'queue']);

/**
 * Whether a ticket is waiting to start: in Planning or the Queue and not archived. A ticket that ran
 * before and was put back (stopped and re-queued) waits too: it is not running, so it can still wait
 */
export function isUnstartedDependent(task: Pick<Task, 'status' | 'metadata'>): boolean {
  return WAITING_STATUSES.has(task.status) && !task.metadata?.archivedAt;
}

/** Whether a ticket still waits for a person's decision (such tickets never block anything) */
function isAwaitingDecisionTicket(task: Pick<Task, 'status' | 'metadata'>): boolean {
  return task.status === 'backlog' && !!task.metadata?.followUpFrom?.needsDecision && !task.metadata?.decision;
}

function findByRef(tasks: readonly Task[], ref: string): Task | undefined {
  return tasks.find((t) => t.id === ref || t.specId === ref);
}

/** Every task `fromId` waits for, directly or not (ids) */
function ancestorsOf(tasks: readonly Task[], fromId: string, extra: Record<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [fromId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const task = tasks.find((t) => t.id === id);
    const refs = [...(task?.metadata?.dependsOnTaskIds ?? []), ...(extra[id] ?? [])];
    for (const ref of refs) {
      const depId = findByRef(tasks, ref)?.id ?? ref;
      if (seen.has(depId)) continue;
      seen.add(depId);
      stack.push(depId);
    }
  }
  return seen;
}

/**
 * The new dependency lists that make unstarted dependents of the `sourceIds` tasks wait for the
 * `newIds` tickets too. A dependent is any ticket in Planning or the Queue that never ran, is not
 * archived and lists a source by id or spec id. Skipped: the new tickets themselves, tickets that
 * are follow-ups of a source (siblings), tickets waiting for a decision, and any dependent the new
 * ticket already depends on, even through other tickets (no cycles). `newDependsOn` gives the
 * dependencies of new tickets that are not in `tasks` yet. Returns the full new `dependsOnTaskIds`
 * per changed ticket; nothing for tickets that already have every id.
 */
export function addDependencyToDependents(
  tasks: readonly Task[],
  sourceIds: readonly string[],
  newIds: readonly string[],
  newDependsOn: Record<string, string[]> = {}
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const sources = sourceIds.map((id) => findByRef(tasks, id)).filter((t): t is Task => !!t);
  const sourceRefs = new Set(sources.flatMap((t) => [t.id, t.specId]));
  const sourceTaskIds = new Set(sources.map((t) => t.id));
  const fresh = newIds.filter((id) => !!id);
  if (sourceRefs.size === 0 || fresh.length === 0) return result;
  const ancestors = new Map(fresh.map((id) => [id, ancestorsOf(tasks, id, newDependsOn)] as const));

  for (const task of tasks) {
    if (fresh.includes(task.id) || sourceTaskIds.has(task.id)) continue;
    if (!isUnstartedDependent(task) || isAwaitingDecisionTicket(task)) continue;
    const followUpFrom = task.metadata?.followUpFrom?.taskId;
    if (followUpFrom && sourceTaskIds.has(followUpFrom)) continue;
    const current = task.metadata?.dependsOnTaskIds ?? [];
    if (!current.some((ref) => sourceRefs.has(ref))) continue;
    const next = [...current];
    for (const id of fresh) {
      if (next.includes(id) || ancestors.get(id)?.has(task.id)) continue;
      next.push(id);
    }
    if (next.length !== current.length) result[task.id] = next;
  }
  return result;
}

/**
 * Open follow-up tickets (and their own follow-ups) of the given tasks that a new dependent should
 * wait for: not archived, not Done, not waiting for a decision. Used when a Spec review ticket is
 * made after the follow-ups of its batch already exist.
 */
export function openFollowUpIdsOf(tasks: readonly Task[], sourceIds: readonly string[]): string[] {
  const sources = new Set(sourceIds.map((id) => findByRef(tasks, id)?.id).filter((id): id is string => !!id));
  const found: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      const from = task.metadata?.followUpFrom?.taskId;
      const fromTask = from ? findByRef(tasks, from) : undefined;
      if (!fromTask || !sources.has(fromTask.id) || sources.has(task.id)) continue;
      sources.add(task.id);
      grew = true;
      if (task.metadata?.archivedAt || task.status === 'done' || isAwaitingDecisionTicket(task)) continue;
      found.push(task.id);
    }
  }
  return found;
}
