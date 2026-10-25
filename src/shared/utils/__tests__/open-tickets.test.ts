import { describe, it, expect } from 'vitest';
import { isOpenTicket, listOpenTickets, ticketNumberLabel } from '../open-tickets';
import type { Task } from '../../types/task';

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task =>
  ({ id, specId: id, projectId: 'p', title: id, description: 'Long   description', status, subtasks: [], logs: [], createdAt: new Date(), updatedAt: new Date(), ...extra }) as Task;

describe('open tickets', () => {
  it('counts the working columns, not done, archived or auto-merged tickets', () => {
    expect(isOpenTicket(task('a', 'backlog'))).toBe(true);
    expect(isOpenTicket(task('a', 'queue'))).toBe(true);
    expect(isOpenTicket(task('a', 'in_progress'))).toBe(true);
    expect(isOpenTicket(task('a', 'ai_review'))).toBe(true);
    expect(isOpenTicket(task('a', 'human_review', { reviewReason: 'completed' }))).toBe(true);
    expect(isOpenTicket(task('a', 'human_review', { reviewReason: 'auto_merged' }))).toBe(false);
    expect(isOpenTicket(task('a', 'done'))).toBe(false);
    expect(isOpenTicket(task('a', 'queue', { metadata: { archivedAt: '2026-01-01' } }))).toBe(false);
  });

  it('lists refs with a squeezed description', () => {
    const refs = listOpenTickets([task('001-x', 'queue'), task('002-y', 'done')]);
    expect(refs).toEqual([{ id: '001-x', title: '001-x', status: 'queue', description: 'Long description' }]);
  });

  it('labels tickets by number', () => {
    expect(ticketNumberLabel('005-weekly')).toBe('#005');
    expect(ticketNumberLabel('abc')).toBe('abc');
  });
});
