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
  fireEvent.click(screen.getByText('Task-wide approval options'));
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
  expect(screen.getByRole('heading', { name: 'Review the participant requirement' })).toBeInTheDocument();
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

const changedScreenshotFindings = [
  {
    "severity": "major",
    "description": "Three changed matrix references (02-operations-refusal 1440x900; 05-debrief-mission-research-week2 1440x900 and 390x844) are committed as regression baselines without human approval; the applicable \u00a714.2 gate (human acceptance before reference diffs are treated as regressions) is unmet and prior owner overrides (task 126 rev 9, task 173 rev 3) expressly exclude future changed images. Real finding, left open deliberately: the manifest approval field and DESIGN_DECISIONS \u00a773 record the re-pin honestly and claim no approval. Resolution needs a human artifact-level acceptance or scoped owner waiver naming exactly these three files, kept distinct from the plates' art/license clearance.",
    "requiresHuman": true,
    "file": "docs/DESIGN_DECISIONS.md",
    "line": 4730
  },
  {
    "severity": "major",
    "description": "Real and left open deliberately: the three changed matrix references (1440x900/02-operations-refusal.png; 1440x900/05-debrief-mission-research-week2.png; 390x844/05-debrief-mission-research-week2.png) are committed as regression baselines while the \u00a714.2 human-acceptance gate is unmet \u2014 receipt 159c1480-6eab-4558-9adb-bcdc34264cb0 is recorded open with no submitted decision, and the task-126 rev-9 / task-173 rev-3 owner overrides expressly exclude future changed images. The code is honest about this (manifest approval string + DESIGN_DECISIONS \u00a774 claim no approval), but only a human artifact-level acceptance or scoped owner waiver naming exactly these three files \u2014 kept distinct from the plates' art/license clearance and r5 lighting deviation \u2014 can close it. Nothing code-side can or should fix it.",
    "requiresHuman": true,
    "file": "docs/DESIGN_DECISIONS.md",
    "line": 4763
  }
] as const;

it('shows the repeated screenshot approval as one concise request with all three exact targets', () => {
  const notes = changedScreenshotFindings.map(note => ({ ...note }));
  let humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding: notes[0] }, notes, 'note-1', '2026-10-28T23:08:45Z');
  humanWork = applyHumanWorkMutation(humanWork, { action: 'create', expectedRevision: 1, finding: notes[1] }, notes, 'note-2', '2026-10-28T23:48:35Z');
  const before = structuredClone(humanWork);
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork } }] });
  render(<HumanWorkPanel task={task} findings={notes} />);
  expect(screen.getAllByRole('heading', { name: 'Review 3 updated screenshots' })).toHaveLength(1);
  expect(screen.getByText('Decide whether these screenshots may become regression baselines. Record approval or requested changes for these files.')).toBeVisible();
  const artifacts = screen.getByRole('list', { name: 'Artifacts named in this request' });
  expect(artifacts.children).toHaveLength(3);
  for (const path of ['1440x900/02-operations-refusal.png', '1440x900/05-debrief-mission-research-week2.png', '390x844/05-debrief-mission-research-week2.png']) {
    expect(screen.getByText(path)).toBeVisible();
  }
  expect(screen.getAllByLabelText('Responsible person')).toHaveLength(1);
  for (const note of notes) expect(screen.getByText(note.description)).not.toBeVisible();
  expect(screen.getByText('docs/DESIGN_DECISIONS.md:4763')).not.toBeVisible();
  expect(screen.getByText('Read all 2 related review notes').closest('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('button', { name: 'Approve human requirements for this task' })).not.toBeVisible();
  expect(screen.getByRole('button', { name: 'Submit and continue' })).toBeDisabled();
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork).toEqual(before);
  expect(mutate).not.toHaveBeenCalled();
});

it('keeps different recorded answers independently editable even when screenshot requests are related', () => {
  const notes = changedScreenshotFindings.map(note => ({ ...note }));
  let humanWork = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding: notes[0] }, notes, 'note-1', '2026-10-28T23:08:45Z');
  humanWork = applyHumanWorkMutation(humanWork, { action: 'create', expectedRevision: 1, finding: notes[1] }, notes, 'note-2', '2026-10-28T23:48:35Z');
  humanWork.items[0].response = 'Please change the refusal screenshot.';
  humanWork.items[1].response = 'Review scheduled; no decision yet.';
  useTaskStore.setState({ tasks: [{ ...task, metadata: { humanWork } }] });
  render(<HumanWorkPanel task={task} findings={notes} />);
  expect(screen.getAllByLabelText('Responsible person')).toHaveLength(2);
  expect(screen.getByDisplayValue('Please change the refusal screenshot.')).toBeVisible();
  expect(screen.getByDisplayValue('Review scheduled; no decision yet.')).toBeVisible();
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork?.items).toHaveLength(2);
});

it.each([
  ['negated participant work', 'The participant study is waived. The screenshots still need an owner decision.', 'Review the participant requirement'],
  ['license clearance', 'The screenshots are visually accepted. The art license clearance still needs evidence from the owner.', 'Review the image requirement'],
  ['negated baseline approval', 'Baseline approval is not required. License clearance remains open for 1440x900/report.png.', 'Review 1 screenshot'],
  ['waived older baseline finding', 'Regression baselines without human approval were the earlier finding. Approval is waived. The license receipt for 1440x900/report.png remains open.', 'Review 1 screenshot'],
  ['unknown human requirement', 'An owner must provide the physical device serial number and test receipt.', 'Review the human requirement'],
])('keeps generic guidance neutral for %s and preserves the complete requirement', (_name, description, title) => {
  const note = { ...finding, requiresHuman: true, description };
  render(<HumanWorkPanel task={task} findings={[note]} />);
  expect(screen.getByRole('heading', { name: title })).toBeVisible();
  expect(screen.getByText(description)).not.toBeVisible();
  expect(screen.getByText(description).closest('details')).not.toHaveAttribute('open');
  expect(screen.queryByText(/Complete the requested participant/)).not.toBeInTheDocument();
  expect(screen.queryByText('Decide whether these screenshots may become regression baselines. Record approval or requested changes for these files.')).not.toBeInTheDocument();
  expect(screen.getByText(/Read the source requirement/)).toBeVisible();
  fireEvent.click(screen.getByText('Read the exact requirement'));
  expect(screen.getByText(description)).toBeVisible();
  expect(useTaskStore.getState().tasks[0].metadata?.humanWork).toBeUndefined();
  expect(mutate).not.toHaveBeenCalled();
});
