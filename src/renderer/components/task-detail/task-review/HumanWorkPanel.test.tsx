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
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue with recorded decisions' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Continue with recorded decisions' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Approve human requirements for this task' }));
  expect(screen.getByRole('button', { name: 'Record approval and continue' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Approver'), { target: { value: 'Ian Andersen' } });
  fireEvent.change(screen.getByLabelText('Approval, waiver or deferral'), { target: { value: 'Approve all current viewports including Research. Defer the participant study until Spec 7.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Record approval and continue' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 1 }, 'p'));
  expect(mutate).toHaveBeenCalledWith('p', '001-human', expect.objectContaining({ action: 'override', expectedRevision: 0, approver: 'Ian Andersen' }));
  expect(screen.getByText('Human approval recorded by Ian Andersen')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Recorded human approval decision' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'What needs your input' })).not.toBeInTheDocument();
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork?.items).toEqual([]);
});

it('can continue with a persisted override even when historic human actions are blank or open', async () => {
  const humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'action-1', '2026-10-27T16:00:00Z');
  const overridden = applyHumanWorkMutation(humanWork, { action: 'override', expectedRevision: 1, approver: 'Ian', reason: 'Waive renewed approval for this task.' }, [finding], '', '2026-10-27T16:01:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork: overridden } }] });
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  expect(screen.getByRole('button', { name: 'Continue with recorded approval' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Continue with recorded approval' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 2 }, 'p'));
  expect(mutate).not.toHaveBeenCalled();
});

it.each(['Reviewed the art asset, approved as is.', 'Image 2 is rejected; replace it.'])('reuses the recorded decision without requesting another submission: %s', async (response) => {
  const created = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'action-1', '2026-10-27T16:00:00Z');
  const submitted = applyHumanWorkMutation(created, { action: 'update', expectedRevision: 1, id: 'action-1', owner: 'Ian', status: 'submitted', response, evidence: 'Recorded owner decision' }, [finding], '', '2026-10-27T16:01:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork: submitted } }] });
  render(<HumanWorkPanel task={task} findings={[finding]} />);
  expect(screen.getByRole('heading', { name: 'Your responses are recorded' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'What needs your input' })).not.toBeInTheDocument();
  expect(screen.getByText('Recorded response from Ian').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: 'Continue with recorded decisions' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 2 }, 'p'));
  expect(mutate).not.toHaveBeenCalled();
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork?.items[0].response).toBe(response);
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork?.approvalOverride).toBeUndefined();
});

it('records a shared response once for related notes and hands back every original requirement', async () => {
  window.electronAPI = { ...window.electronAPI, getHumanReviewPacket: vi.fn(async () => ({ success: true, data: { root: '/project', location: 'project' as const, artifacts: [] } })) };
  const notes = [finding, { ...finding, line: 40, description: 'A real reviewer must approve the committed images.' }];
  let humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding: notes[0] }, notes, 'note-1', '2026-10-27T16:00:00Z');
  humanWork = applyHumanWorkMutation(humanWork, { action: 'create', expectedRevision: 1, finding: notes[1] }, notes, 'note-2', '2026-10-27T16:01:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork } }] });
  render(<HumanWorkPanel task={task} findings={notes} />);
  expect(screen.getAllByLabelText('Responsible person')).toHaveLength(1);
  expect(screen.getByText('Read all 2 related review notes')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Responsible person'), { target: { value: 'Ian' } });
  fireEvent.change(screen.getByLabelText('Response, decision or participant observations'), { target: { value: 'The current images are accepted.' } });
  fireEvent.change(screen.getByLabelText('Evidence references (report paths, review notes, artifact URLs)'), { target: { value: 'docs/reviewer-notes.md' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }));
  await waitFor(() => expect(review).toHaveBeenCalledWith('001-human', false, undefined, undefined, { humanWorkRevision: 3 }, 'p'));
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate).toHaveBeenCalledWith('p', '001-human', expect.objectContaining({ action: 'update', id: 'note-2', relatedIds: ['note-1'] }));
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork?.items.map(item => item.finding)).toEqual(notes);
});

it('shows worktree-aware artifact links, missing generated art and the quoted limitations', async () => {
  task = { ...task, id: '002-materials', specId: '002-materials' };
  const getPacket = vi.fn(async () => ({ success: true, data: { root: '/project/.workbench/worktrees/tasks/001-human', location: 'worktree', limitations: 'The portraits are silhouettes.', artifacts: [
    { path: 'docs/report.md', kind: 'report', label: 'Delivery report', available: true },
    { path: 'docs/protocol.md', kind: 'protocol', label: 'Study protocol', available: true },
    { path: 'art/source/generated', kind: 'asset', label: 'art/source/generated', available: false },
  ] } }));
  const open = vi.fn(async () => ({ success: true }));
  window.electronAPI = { ...window.electronAPI, getHumanReviewPacket: getPacket as never, openHumanReviewArtifact: open };
  const view = render(<HumanWorkPanel task={task} findings={[{ ...finding, description: 'Three participant sessions and human review of the screenshots are required.' }]} />);
  expect(screen.getByText(/Complete the requested participant sessions/)).toBeInTheDocument();
  expect(await screen.findByText(/These files come from this task’s worktree/)).toBeInTheDocument();
  expect(screen.getByText(/No generated image files found in this location/)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Show in file manager' })[0]);
  await waitFor(() => expect(open).toHaveBeenCalledWith('p', '002-materials', 'docs/report.md', 'reveal', '/project/.workbench/worktrees/tasks/001-human'));
  expect(screen.getByText('The portraits are silhouettes.')).toBeInTheDocument();
  view.rerender(<HumanWorkPanel task={{ ...task }} findings={[finding]} />);
  expect(getPacket).toHaveBeenCalledTimes(1);
});

it('never partially saves grouped responses against an older main process', async () => {
  const notes = [finding, { ...finding, line: 40, description: 'A real reviewer must approve the committed images.' }];
  let humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding: notes[0] }, notes, 'note-1', '2026-10-27T16:00:00Z');
  humanWork = applyHumanWorkMutation(humanWork, { action: 'create', expectedRevision: 1, finding: notes[1] }, notes, 'note-2', '2026-10-27T16:01:00Z');
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork } }] });
  window.electronAPI = { ...window.electronAPI, getHumanReviewPacket: vi.fn(async () => { throw new Error("No handler registered for 'task:humanReviewPacket'"); }) };
  render(<HumanWorkPanel task={task} findings={notes} />);
  fireEvent.change(screen.getByLabelText('Responsible person'), { target: { value: 'Ian' } });
  fireEvent.change(screen.getByLabelText('Response, decision or participant observations'), { target: { value: 'Current images accepted' } });
  fireEvent.change(screen.getByLabelText('Evidence references (report paths, review notes, artifact URLs)'), { target: { value: 'Recorded review notes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Restart Workbench');
  expect(mutate).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});
