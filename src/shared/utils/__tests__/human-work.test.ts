import { describe, expect, it } from 'vitest';
import { applyHumanWorkMutation, buildHumanWorkFeedback, groupHumanWorkItems } from '../human-work';
import type { ReviewRoundFinding } from '../../types/claude-code';
const finding: ReviewRoundFinding = { severity: 'blocker', description: 'A real reviewer must approve the committed images.', file: 'docs/report.md', line: 7 };
const at = '2026-10-27T16:00:00.000Z';
const create = () => applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [finding], 'human-1', at);
describe('human work records', () => {
  it('tracks an immutable source finding, deduplicates it, and keeps progress/submission history', () => {
    const first = create();
    expect(first.items[0]).toMatchObject({ finding, owner: '', status: 'open' });
    const duplicate = applyHumanWorkMutation(first, { action: 'create', expectedRevision: 1, finding }, [finding], 'duplicate', at);
    expect(duplicate).toEqual(first);
    const next = applyHumanWorkMutation(first, { action: 'update', expectedRevision: 1, id: 'human-1', owner: 'Ian', status: 'in_progress', response: 'Review arranged', evidence: '' }, [finding], '', at);
    expect(next.items[0].history[0]).toMatchObject({ status: 'open' });
    expect(first.items[0].status).toBe('open');
    const submitted = applyHumanWorkMutation(next, { action: 'update', expectedRevision: 2, id: 'human-1', owner: 'Ian', status: 'submitted', response: 'Reviewer rejected image 2; remaining images approved.', evidence: 'docs/review-receipt.md contains the reviewer, date and decisions.' }, [finding], '', at);
    expect(submitted.items[0].history).toHaveLength(2);
    const feedback = buildHumanWorkFeedback(submitted, 3, [finding]);
    expect(feedback).toContain('Reviewer rejected image 2');
    expect(feedback).toContain('does not approve or waive');
    expect(feedback).toContain('Responsible person: Ian');
    expect(submitted.items[0].finding).toEqual(finding);
  });
  it('rejects stale edits, unknown findings, incomplete submissions and untracked blockers', () => {
    const first = create();
    expect(() => applyHumanWorkMutation(first, { action: 'create', expectedRevision: 0, finding }, [finding], 'new', at)).toThrow('changed');
    expect(() => applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding }, [], 'new', at)).toThrow('finding changed');
    expect(() => applyHumanWorkMutation(first, { action: 'update', expectedRevision: 1, id: 'human-1', owner: '', status: 'submitted', response: 'done', evidence: '' }, [], '', at)).toThrow('responsible person');
    expect(() => buildHumanWorkFeedback(first, 1)).toThrow('every human action');
    const submitted = applyHumanWorkMutation(first, { action: 'update', expectedRevision: 1, id: 'human-1', owner: 'Ian', status: 'submitted', response: 'Actual decision', evidence: 'docs/review.md' }, [], '', at);
    expect(() => buildHumanWorkFeedback(submitted, 2, [finding, { ...finding, description: 'Three participants need to be observed.' }])).toThrow('every current blocker');
    expect(() => buildHumanWorkFeedback(submitted, 1)).toThrow('changed');
  });
});

it('groups related reworded gates for display and submits one response without deleting any source finding', () => {
  const notes = [
    'Gate 6 human sign-off remains unmet. Three real participant sessions, verbatim observations and emotional outcomes, observed P0 dispositions, participant-derived priorities and human approval of comparisons, changed dialog captures and art are required.',
    'Human sign-off remains unmet. Real participant sessions must supply observations, emotional outcomes, observed P0 dispositions and participant-derived priorities. The comparisons, dialog captures and shipped art require human review.',
    'Gate 6 human sign-off remains unmet. Three real participants must execute the protocol, with quotes, target outcomes, observed P0 dispositions and participant-derived priorities. Authorized humans must record decisions on the gallery, changed captures and release art.',
    'Gate 6 human sign-off remains unmet. Three real participant sessions must supply actual observations and quotes, comprehension outcomes, observed P0 dispositions and participant-derived priorities. Human review of comparisons, dialog captures and art remains required.',
  ].map((description, line) => ({ ...finding, description, line }));
  let stream = applyHumanWorkMutation(undefined, { action: 'create', expectedRevision: 0, finding: notes[0] }, notes, 'note-0', at);
  for (let i = 1; i < notes.length; i++) stream = applyHumanWorkMutation(stream, { action: 'create', expectedRevision: stream.revision, finding: notes[i] }, notes, `note-${i}`, at);
  expect(groupHumanWorkItems(stream.items)).toHaveLength(1);
  const submitted = applyHumanWorkMutation(stream, { action: 'update', expectedRevision: 4, id: 'note-3', relatedIds: ['note-0', 'note-1', 'note-2'], owner: 'Ian', status: 'submitted', response: 'Study remains pending; current screenshots reviewed.', evidence: 'docs/review-notes.md' }, notes, '', at);
  expect(submitted.revision).toBe(5);
  expect(submitted.items.map(item => item.finding)).toEqual(notes);
  expect(submitted.items.every(item => item.status === 'submitted' && item.history.length === 1)).toBe(true);
  expect(buildHumanWorkFeedback(submitted, 5, notes)).toContain('Study remains pending');
  expect(groupHumanWorkItems(submitted.items)).toHaveLength(1);
  const changed = structuredClone(submitted); changed.items[0].response = 'Different participant evidence';
  expect(groupHumanWorkItems(changed.items).find(group => group.some(item => item.id === 'note-0'))).toHaveLength(1);
  expect(groupHumanWorkItems(changed.items).length).toBeGreaterThan(1);
  const foreign = structuredClone(stream); foreign.items[0].finding.file = 'docs/other-scope.md';
  expect(groupHumanWorkItems(foreign.items).length).toBeGreaterThan(1);
  expect(() => applyHumanWorkMutation(stream, { action: 'update', expectedRevision: 4, id: 'note-3', relatedIds: ['missing'], owner: 'Ian', status: 'submitted', response: 'Approved', evidence: 'notes' }, notes, '', at)).toThrow('not found');
  expect(stream.items.every(item => item.status === 'open' && !item.history.length)).toBe(true);
});

it('records an owner override without fabricated evidence, preserves history and supersedes old handoff constraints', () => {
  const first = create();
  const override = applyHumanWorkMutation(first, { action: 'override', expectedRevision: 1, approver: 'Ian Andersen', reason: 'Approve all current viewports. Defer the participant study until Spec 7.' }, [finding], '', at);
  expect(override.items).toEqual(first.items);
  expect(override.approvalOverride).toMatchObject({ scope: 'task-human-approval', approver: 'Ian Andersen', revision: 2 });
  const text = buildHumanWorkFeedback(override, 2, [{ ...finding, description: 'A reworded requirement with no new facts.' }]);
  expect(text).toContain('Owner override');
  expect(text).toContain('do not demand renewed human sign-off');
  expect(text).toContain('Defer the participant study until Spec 7');
  const amended = applyHumanWorkMutation(override, { action: 'override', expectedRevision: 2, approver: 'Ian Andersen', reason: 'Approve current Research too.' }, [], '', at);
  expect(amended.overrideHistory).toEqual([override.approvalOverride]);
  expect(() => applyHumanWorkMutation(amended, { action: 'override', expectedRevision: 2, approver: 'Ian', reason: 'stale' }, [], '', at)).toThrow('changed');
  expect(() => applyHumanWorkMutation(first, { action: 'override', expectedRevision: 1, approver: '', reason: 'approve' }, [], '', at)).toThrow('approver and reason');
});
