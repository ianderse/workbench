/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../shared/i18n';
import { ProjectMemoryDialog } from './ProjectMemoryDialog';
import { useProjectMemoryStore } from '../../stores/project-memory-store';
import { useProjectStore } from '../../stores/project-store';
import type { Project } from '../../../shared/types';
import type { MemoryMutation, ProjectMemory } from '../../../shared/types/project-memory';

let entry: ProjectMemory;
const mutate = vi.fn();
const list = vi.fn();
beforeEach(() => {
  entry = { id: 'memory-1', projectId: 'project-a', revision: 1, status: 'proposed', verification: 'unverified', at: '2026-10-27T12:00:00Z', kind: 'lesson', title: 'Inspect Vitest output', body: 'Read the failing test output before retrying.', source: { type: 'task', reference: '001-failure', evidence: 'The worker exited; no fix verified.' }, history: [] };
  useProjectStore.setState({ projects: [{ id: 'project-a', settings: { selfImprove: true } } as Project] });
  useProjectMemoryStore.setState({ entries: {}, contexts: {}, requiresRestart: false });
  list.mockImplementation(async () => ({ success: true, data: [entry] }));
  mutate.mockImplementation(async (_projectId: string, mutation: MemoryMutation) => {
    if (mutation.action === 'accept') entry = { ...entry, status: 'active', verification: 'user-confirmed', revision: 2 };
    return { success: true, data: entry };
  });
  window.electronAPI = { ...window.electronAPI, listProjectMemories: list, mutateProjectMemory: mutate, readMemorySource: vi.fn(async () => ({ success: true, data: 'The original ticket description' })) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows source evidence, accepts explicitly, and revises through the expected revision', async () => {
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  await screen.findByText('Inspect Vitest output');
  fireEvent.click(screen.getByText('Optional suggestions (1)'));
  expect(screen.getByText(/^Unverified proposal/)).toBeInTheDocument();
  expect(screen.getByText(/^Not used in task context yet/)).toHaveTextContent('does not verify tests or approve the source task');
  expect(screen.getByText('The worker exited; no fix verified.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Task: 001-failure' }));
  expect(await screen.findByText('The original ticket description')).toBeInTheDocument();
  expect(screen.getByText('The worker exited; no fix verified.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use in future tasks' }));
  await screen.findByText(/^Confirmed by a person; checks not independently verified/);
  expect(mutate).toHaveBeenCalledWith('project-a', { action: 'accept', id: 'memory-1', expectedRevision: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Correct' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Inspect Vitest stderr too' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(mutate).toHaveBeenLastCalledWith('project-a', expect.objectContaining({ action: 'revise', id: 'memory-1', expectedRevision: 2, content: expect.objectContaining({ title: 'Inspect Vitest stderr too' }) })));
});

it('reuses the cached list on reopen and keeps a failed capture draft available for retry', async () => {
  const view = render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} taskId="001-failure" />);
  await screen.findByText('Inspect Vitest output');
  view.rerender(<ProjectMemoryDialog projectId="project-a" open={false} onOpenChange={() => {}} taskId="001-failure" />);
  view.rerender(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} taskId="001-failure" />);
  expect(list).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New lesson' } });
  fireEvent.change(screen.getByLabelText('What should a future worker know, and why?'), { target: { value: 'Do not repeat this failure.' } });
  fireEvent.change(screen.getByLabelText('Supporting evidence and unresolved limits'), { target: { value: 'Observed exit code 1.' } });
  mutate.mockResolvedValueOnce({ success: false, error: 'Storage interrupted' });
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Title')).toHaveValue('New lesson');
  const first = mutate.mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: 'Save proposal' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
  expect(mutate.mock.calls[1][1].requestId).toBe(first.requestId);
});

it('blocks mutations while project memory is disabled', async () => {
  useProjectStore.setState({ projects: [{ id: 'project-a', settings: { selfImprove: false } } as Project] });
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  await screen.findByText('Inspect Vitest output');
  fireEvent.click(screen.getByText('Optional suggestions (1)'));
  expect(screen.getByRole('button', { name: 'Use in future tasks' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save proposal' })).toBeDisabled();
});

it('explains a renderer/main version mismatch and does not offer capture until the backend is loaded', async () => {
  list.mockRejectedValueOnce(new Error("Error invoking remote method 'projectMemory:list': Error: No handler registered for 'projectMemory:list'"));
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Restart the whole app');
  expect(screen.getByRole('alert')).not.toHaveTextContent('No handler registered');
  expect(screen.queryByRole('button', { name: 'Save proposal' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('Inspect Vitest output');
  expect(screen.getByRole('button', { name: 'Save proposal' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows both conflicting claims and resolves against the displayed revisions', async () => {
  const old = { ...entry, id: 'old-memory', title: 'Earlier Vitest decision', body: 'Read stdout first.', status: 'active' as const, verification: 'user-confirmed' as const, revision: 4 };
  entry = { ...entry, reviewReason: 'conflict', conflictsWith: [old.id] };
  list.mockImplementation(async () => ({ success: true, data: [old, entry] }));
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  expect(await screen.findAllByText('Read stdout first.')).toHaveLength(2);
  expect(screen.getByText('Conflicting claims need a decision')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Use in future tasks' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Use new memory' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('project-a', { action: 'resolve', id: 'memory-1', expectedRevision: 1, conflicts: [{ id: 'old-memory', revision: 4 }] }));
});

it('dismisses a proposal against its displayed revision and explains the procedure category', async () => {
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  await screen.findByText('Inspect Vitest output');
  fireEvent.click(screen.getByText('Optional suggestions (1)'));
  expect(screen.queryByRole('button', { name: 'Remove from recall' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'procedure' } });
  expect(screen.getByText(/An implementation detail is not a procedure/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss proposal' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('project-a', { action: 'delete', id: entry.id, expectedRevision: 1 }));
});

it('keeps routine suggestions collapsed and presents consequential decisions before accepted guidance', async () => {
  const suggestion = { ...entry, id: 'optional', title: 'Routine task finding' };
  const accepted = { ...entry, id: 'accepted', title: 'Accepted constraint', status: 'active' as const, verification: 'user-confirmed' as const };
  entry = { ...entry, title: 'Conflicting change', reviewReason: 'conflict', conflictsWith: [accepted.id] };
  list.mockImplementation(async () => ({ success: true, data: [suggestion, accepted, entry] }));
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  await screen.findByText('Optional suggestions (1)');
  expect(screen.getByText('Routine task finding')).not.toBeVisible();
  expect(screen.getAllByRole('heading', { level: 3 }).slice(0, 2).map((heading) => heading.textContent)).toEqual(['Conflicting change', 'Accepted constraint']);
  expect(screen.getByRole('button', { name: 'Use new memory' })).toBeVisible();
  fireEvent.click(screen.getByText('Optional suggestions (1)'));
  expect(screen.getByText('Routine task finding')).toBeVisible();
});

it('keeps a user-authored proposal immediately available without opening optional suggestions', async () => {
  entry = { ...entry, source: { type: 'user', reference: 'Owner instruction', evidence: 'Explicit scoped guidance.' } };
  render(<ProjectMemoryDialog projectId="project-a" open onOpenChange={() => {}} />);
  await screen.findByText('Inspect Vitest output');
  expect(screen.queryByText(/^Optional suggestions/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Use in future tasks' })).toBeVisible();
});
