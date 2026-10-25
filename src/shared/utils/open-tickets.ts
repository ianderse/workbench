/** Open tickets: tickets that are not merged yet, which a new ticket can wait for */
import type { Task } from '../types/task';
import type { OpenTicketRef } from '../types/task-breakdown';

const OPEN_STATUSES = new Set(['backlog', 'queue', 'in_progress', 'ai_review', 'human_review']);
const MAX_DESCRIPTION_CHARS = 240;

/**
 * Whether a ticket still has to be merged: not archived, not done, and not already merged by
 * autonomous mode. Only the five working columns count.
 */
export function isOpenTicket(task: Pick<Task, 'status' | 'reviewReason' | 'metadata'>): boolean {
  if (task.metadata?.archivedAt) return false;
  if (!OPEN_STATUSES.has(task.status)) return false;
  if (task.status === 'human_review' && task.reviewReason === 'auto_merged') return false;
  return true;
}

export function toOpenTicketRef(task: Pick<Task, 'id' | 'title' | 'status' | 'description'>): OpenTicketRef {
  const description = (task.description ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    description: description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}...` : description,
  };
}

export function listOpenTickets(tasks: readonly Task[]): OpenTicketRef[] {
  return tasks.filter(isOpenTicket).map(toOpenTicketRef);
}

/** "#005" for a ticket id such as "005-weekly-campaign"; the id itself when it has no number */
export function ticketNumberLabel(id: string): string {
  const match = /^(\d+)/.exec(id);
  return match ? `#${match[1]}` : id;
}
