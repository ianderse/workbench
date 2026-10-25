/**
 * Queue grooming: the pure rules
 * ==============================
 *
 * After a task is merged, one model call looks at the tickets still waiting in Planning and the
 * Queue. This module validates what comes back (`normalizeGroomingResult`), writes and removes the
 * context notes added to tickets, and works out what archiving a ticket does to the others'
 * dependencies. Nothing here touches the disk or a process.
 */
import type { GroomingNewTask, GroomingResult, GroomingUpdate } from '../types/queue-grooming';

/** The fields of a task the rules need */
export interface GroomTask {
  id: string;
  title: string;
  status: string;
  archived?: boolean;
  dependsOn: string[];
}

export const MAX_NOTE_CHARS = 600;
export const MAX_REASON_CHARS = 400;
export const MAX_NEW_TASKS = 5;
const MAX_NEW_TITLE_CHARS = 120;
const MAX_NEW_DESCRIPTION_CHARS = 4000;

/** Statuses of the tickets grooming may touch: Planning and Queue */
export function isGroomableStatus(status: string): boolean {
  return status === 'backlog' || status === 'queue';
}

/** "001-prng" -> "001"; ids that don't start with digits stay whole */
export function taskNumber(taskId: string): string {
  return /^(\d+)/.exec(taskId)?.[1] ?? taskId;
}

/** The text appended to a ticket's description for a note */
export function buildNoteBlock(fromTaskId: string, note: string): string {
  return `\n\n---\n**Update after #${taskNumber(fromTaskId)} merged**\n${note.trim()}`;
}

export function appendNoteBlock(description: string, block: string): string {
  return `${description.replace(/\s+$/, '')}${block}`;
}

/** Remove a block added by `appendNoteBlock` (the description is left alone when the block was edited away) */
export function removeNoteBlock(description: string, block: string): string {
  const index = description.lastIndexOf(block);
  if (index < 0) {
    const trimmed = block.trim();
    const at = trimmed ? description.lastIndexOf(trimmed) : -1;
    if (at < 0) return description;
    return `${description.slice(0, at)}${description.slice(at + trimmed.length)}`.replace(/(\n\n---)?\s*$/, '');
  }
  return `${description.slice(0, index)}${description.slice(index + block.length)}`;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n').slice(0, max).trim() : '';
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) !== '' && norm(a) === norm(b);
}

/** Whether `from` waits (directly or transitively) for `target` */
export function dependsTransitively(tasks: readonly GroomTask[], from: string, target: string): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) stack.push(dep);
  }
  return false;
}

/**
 * Clean up the model's answer. Unknown task ids are dropped; only tickets in Planning or the
 * Queue (not archived, never the merged task) can be updated, and running tickets in `noteOnlyIds` get notes only; each ticket gets one update;
 * a ticket is never a duplicate of a ticket that is itself being removed; new cards only wait for
 * existing tasks that stay (so their dependencies cannot form a cycle).
 */
export function normalizeGroomingResult(
  raw: unknown,
  tasks: readonly GroomTask[],
  mergedTaskId: string,
  /** Running tickets that may get a note (never an obsolete or duplicate update) */
  noteOnlyIds: ReadonlySet<string> = new Set()
): GroomingResult {
  const live = tasks.filter((t) => !t.archived);
  const liveIds = new Set(live.map((t) => t.id));
  const groomable = new Set(live.filter((t) => isGroomableStatus(t.status) && t.id !== mergedTaskId).map((t) => t.id));
  const noteOnly = new Set([...noteOnlyIds].filter((id) => liveIds.has(id) && id !== mergedTaskId && !groomable.has(id)));

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawUpdates = Array.isArray(record.updates) ? record.updates : [];
  const rawNew = Array.isArray(record.newTasks) ? record.newTasks : [];

  const updates: GroomingUpdate[] = [];
  const touched = new Set<string>();
  // Tickets that would be archived by an accepted update
  const removed = new Set<string>();
  // Kept ticket for each duplicate, to point new cards at it
  const redirect = new Map<string, string>();

  // One update per ticket survives: the first one in the model's order
  for (const item of rawUpdates) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const taskId = typeof r.taskId === 'string' ? r.taskId.trim() : '';
    if (!(groomable.has(taskId) || noteOnly.has(taskId)) || touched.has(taskId)) continue;
    if (noteOnly.has(taskId) && r.kind !== 'note') continue;
    const reason = cleanText(r.reason, MAX_REASON_CHARS);
    if (r.kind === 'note') {
      const note = cleanText(r.note, MAX_NOTE_CHARS);
      if (!note) continue;
      touched.add(taskId);
      updates.push({ taskId, kind: 'note', note, reason });
    } else if (r.kind === 'obsolete') {
      if (!reason) continue;
      touched.add(taskId);
      removed.add(taskId);
      updates.push({ taskId, kind: 'obsolete', reason });
    } else if (r.kind === 'duplicate') {
      const duplicateOf = typeof r.duplicateOf === 'string' ? r.duplicateOf.trim() : '';
      if (!reason || !duplicateOf || duplicateOf === taskId || !liveIds.has(duplicateOf)) continue;
      // The kept ticket must stay: not removed already, and not a ticket that waits for this one
      // (moving dependents onto it would then make it wait for itself)
      if (removed.has(duplicateOf) || redirect.has(duplicateOf)) continue;
      if (dependsTransitively(live, duplicateOf, taskId)) continue;
      touched.add(taskId);
      removed.add(taskId);
      redirect.set(taskId, duplicateOf);
      updates.push({ taskId, kind: 'duplicate', duplicateOf, reason });
    }
  }
  // A duplicate accepted early may point at a ticket that a later update removes: drop it
  // (repeat, since dropping one can free the ticket another one pointed at)
  let safeUpdates = updates;
  for (;;) {
    const bad = safeUpdates.find((u) => u.kind === 'duplicate' && removed.has(u.duplicateOf));
    if (!bad) break;
    removed.delete(bad.taskId);
    redirect.delete(bad.taskId);
    safeUpdates = safeUpdates.filter((u) => u !== bad);
  }

  const newTasks: GroomingNewTask[] = [];
  for (const item of rawNew) {
    if (newTasks.length >= MAX_NEW_TASKS) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = cleanText(r.title, MAX_NEW_TITLE_CHARS).replace(/\.$/, '');
    const description = cleanText(r.description, MAX_NEW_DESCRIPTION_CHARS);
    if (!title || !description) continue;
    // Not a copy of a ticket that exists or of a card proposed above
    if (live.some((t) => sameTitle(t.title, title)) || newTasks.some((t) => sameTitle(t.title, title))) continue;
    const deps: string[] = [];
    if (Array.isArray(r.dependsOn)) {
      for (const dep of r.dependsOn) {
        if (typeof dep !== 'string') continue;
        const id = redirect.get(dep.trim()) ?? dep.trim();
        if (!liveIds.has(id) || removed.has(id) || deps.includes(id)) continue;
        deps.push(id);
      }
    }
    newTasks.push({ title, description, dependsOn: deps, reason: cleanText(r.reason, MAX_REASON_CHARS) });
  }

  return { updates: safeUpdates, newTasks };
}

export interface ArchivePlan {
  /** Tasks to archive */
  archive: string[];
  /** New `dependsOn` for every task whose dependencies change */
  setDependsOn: Record<string, string[]>;
}

/**
 * What archiving `taskId` does to the others' dependencies. Without `replacement` its dependents
 * simply stop waiting for it; with one (a duplicate) they wait for the kept ticket instead, unless
 * the kept ticket itself waits for that dependent.
 */
export function planArchive(tasks: readonly GroomTask[], taskId: string, replacement?: string): ArchivePlan {
  const setDependsOn: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.id === taskId || !task.dependsOn.includes(taskId)) continue;
    const next = task.dependsOn.filter((dep) => dep !== taskId);
    if (replacement && replacement !== task.id && !next.includes(replacement) && !dependsTransitively(tasks, replacement, task.id)) {
      next.push(replacement);
    }
    setDependsOn[task.id] = next;
  }
  return { archive: [taskId], setDependsOn };
}
