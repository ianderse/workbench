/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import type { Task } from '../../../../shared/types';
import type { HumanWorkMutation } from '../../../../shared/types/human-work';
import { applyHumanWorkMutation } from '../../../../shared/utils/human-work';
import { useTaskStore } from '../../../stores/task-store';
import { HumanWorkPanel } from './HumanWorkPanel';
import { HumanWorkInbox } from '../../HumanWorkInbox';
const finding = { severity: 'blocker' as const, description: 'A real reviewer must approve the images.', file: 'docs/report.md', line: 7 };
let task: Task;
const mutate = vi.fn();
const review = vi.fn();
beforeEach(() => {
  task = { id: '001-human', specId: '001-human', projectId: 'p', status: 'human_review', title: 'Acceptance evidence', metadata: {} } as Task;
  useTaskStore.setState({ tasks: [task] });
  mutate.mockImplementation(async (_project: string, _task: string, mutation: HumanWorkMutation) => ({ success: true, data: applyHumanWorkMutation(useTaskStore.getState().tasks[0].metadata?.humanWork, mutation, [finding], 'action-1', '2026-10-27T16:00:00Z') }));
  review.mockResolvedValue({ success: true });
  window.electronAPI = { ...window.electronAPI, mutateHumanWork: mutate, submitReview: review };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('tracks a legacy review blocker, requires a complete receipt, and hands off the exact saved revision', async () => {
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Track as human action' }));
  await screen.findByLabelText('Responsible person');
  expect(screen.getByRole('button', { name: 'Submit and continue' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Responsible person'), { target: { value: 'Ian' } });
  fireEvent.change(screen.getByLabelText('Human action status'), { target: { value: 'submitted' } });
  expect(screen.getByRole('button', { name: 'Save human work' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Response, decision or participant observations'), { target: { value: 'Reviewer rejected image 2.' } });
  fireEvent.change(screen.getByLabelText('Evidence references (report paths, review notes, artifact URLs)'), { target: { value: 'docs/reviewer-notes.md' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save human work' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with submitted evidence' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Continue with submitted evidence' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 2 }, 'p'));
  expect(await screen.findByRole('status')).toHaveTextContent('existing work and session are preserved');
});
it('keeps open human work visible on the board and opens the owning task', () => {
  const humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'action-1', new Date().toISOString());
  const open = vi.fn();
  render(<HumanWorkInbox tasks={[{ ...task, metadata: { humanWork } }]} onOpen={open} />);
  expect(screen.getByText('Unassigned: Open')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open human work' }));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
});

it('submits a fully filled saved Open action and uses its new revision for the handoff', async () => {
  const created = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'action-1', '2026-10-27T16:00:00Z');
  const open = applyHumanWorkMutation(created, { action: 'update', expectedRevision: 1, id: 'action-1', owner: 'Ian', status: 'open', response: 'Approved', evidence: 'Admin approval: all current viewports are acceptable; no viewport/hash pairs required.' }, [finding], '', '2026-10-27T16:01:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork: open } }] });
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  expect(screen.getByLabelText('Human action status')).toHaveValue('open');
  fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 3 }, 'p'));
  expect(mutate).toHaveBeenCalledWith('p', '001-human', expect.objectContaining({ action: 'update', expectedRevision: 2, status: 'submitted', response: 'Approved', evidence: open.items[0].evidence }));
});

it('saves unsaved complete fields before continuing and never launches if a save fails', async () => {
  const humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'action-1', '2026-10-27T16:00:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork } }] });
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  fireEvent.change(screen.getByLabelText('Responsible person'), { target: { value: 'Ian' } });
  fireEvent.change(screen.getByLabelText('Response, decision or participant observations'), { target: { value: 'Approved current scope' } });
  fireEvent.change(screen.getByLabelText('Evidence references (report paths, review notes, artifact URLs)'), { target: { value: 'Explicit instruction recorded here' } });
  expect(screen.getByRole('button', { name: 'Submit and continue' })).toBeEnabled();
  mutate.mockResolvedValueOnce({ success: false, error: 'Human work changed; refresh before saving' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Human work changed');
  expect(review).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Response, decision or participant observations')).toHaveValue('Approved current scope');
  fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 2 }, 'p'));
});

it('records an explicit task override and continues without forcing additional approval evidence', async () => {
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Override human approval for this task' }));
  expect(screen.getByRole('button', { name: 'Apply override and continue' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Approver'), { target: { value: 'Ian Andersen' } });
  fireEvent.change(screen.getByLabelText('Override decision and reason'), { target: { value: 'Approve all current viewports including Research. Defer the participant study until Spec 7.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply override and continue' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 1 }, 'p'));
  expect(mutate).toHaveBeenCalledWith('p', '001-human', expect.objectContaining({ action: 'override', expectedRevision: 0, approver: 'Ian Andersen' }));
  expect(screen.getByText('Human approval overridden by Ian Andersen')).toBeInTheDocument();
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork?.items).toEqual([]);
});

it('can continue with a persisted override even when historic human actions are blank or open', async () => {
  const humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'action-1', '2026-10-27T16:00:00Z');
  const overridden = applyHumanWorkMutation(humanWork, { action: 'override', expectedRevision: 1, approver: 'Ian', reason: 'Waive renewed approval for this task.' }, [finding], '', '2026-10-27T16:01:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork: overridden } }] });
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  expect(screen.getByRole('button', { name: 'Continue with override' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with override' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 2 }, 'p'));
  expect(mutate).not.toHaveBeenCalled();
});
