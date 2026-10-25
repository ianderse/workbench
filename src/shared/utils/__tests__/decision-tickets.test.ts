import { describe, it, expect } from 'vitest';
import {
  MAX_DECISION_TICKETS,
  buildDecisionBlock,
  buildDecisionPrompt,
  buildDecisionTicketDescription,
  getDecisionQuestion,
  isAwaitingDecision,
  normalizeDecisionResult,
  normalizeSuggestion,
  resolveDecisionText,
  initialDecisionText,
} from '../decision-tickets';

describe('normalizeDecisionResult', () => {
  it('keeps valid tickets and the record, queue defaults to true', () => {
    const result = normalizeDecisionResult({
      tickets: [
        { title: 'Add forgetting.', description: 'Do it', queue: true },
        { title: 'Add debate', description: 'Plan it', queue: false },
        { title: 'Add mentoring', description: 'Do it too' },
      ],
      decisionRecord: '- forgetting: add',
    });
    expect(result.tickets.map((t) => [t.title, t.queue])).toEqual([
      ['Add forgetting', true],
      ['Add debate', false],
      ['Add mentoring', true],
    ]);
    expect(result.decisionRecord).toBe('- forgetting: add');
  });

  it('drops incomplete and duplicate tickets and caps at the maximum', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, description: 'd', queue: true }));
    const result = normalizeDecisionResult({
      tickets: [{ title: '', description: 'd' }, { title: 'x' }, 'junk', null, { title: 'T0', description: 'again' }, ...many],
      decisionRecord: 5,
    });
    expect(result.tickets).toHaveLength(MAX_DECISION_TICKETS);
    expect(result.tickets.map((t) => t.title)).toEqual(['T0', 'T1', 'T2', 'T3']);
    expect(result.decisionRecord).toBe('');
  });

  it('removes dashes the prompt forbids', () => {
    const result = normalizeDecisionResult({ tickets: [{ title: 'A — B', description: 'x – y', queue: true }], decisionRecord: 'a — b' });
    expect(result.tickets[0]).toMatchObject({ title: 'A, B', description: 'x, y' });
    expect(result.decisionRecord).toBe('a, b');
  });

  it('returns nothing for garbage', () => {
    expect(normalizeDecisionResult(null)).toEqual({ tickets: [], decisionRecord: '' });
    expect(normalizeDecisionResult('x')).toEqual({ tickets: [], decisionRecord: '' });
    expect(normalizeDecisionResult({ tickets: 'no' })).toEqual({ tickets: [], decisionRecord: '' });
  });
});

describe('decision texts and state', () => {
  it('builds the prompt with the ticket, source, open tickets and decision', () => {
    const prompt = buildDecisionPrompt({
      ticket: { id: '017-decide', title: 'Decide', description: 'Pick' },
      source: { id: '014-feature', title: 'Feature', headline: 'Does it' },
      openTickets: [{ id: '015-map', title: 'Map', status: 'queue' }],
      decision: 'Add forgetting',
    });
    expect(prompt).toContain('<decision_ticket id="017-decide"');
    expect(prompt).toContain('<source_task id="014-feature"');
    expect(prompt).toContain('column="Queue"');
    expect(prompt).toContain('Add forgetting');
  });

  it('builds the blocks', () => {
    expect(buildDecisionBlock('tickets', 'go', '- a: add')).toContain('## Decision\n\n- a: add\n\n**Your words:** go');
    expect(buildDecisionBlock('deferred', 'later')).toContain('Deferred for now.');
    expect(buildDecisionBlock('rejected', '')).not.toContain('Your words');
    expect(buildDecisionTicketDescription({ title: 't', description: 'work', queue: true }, '017-decide')).toContain('#017');
  });

  it('knows when a ticket awaits a decision', () => {
    const base = { followUpFrom: { taskId: '1', item: 'x', needsDecision: true } };
    expect(isAwaitingDecision(base)).toBe(true);
    expect(isAwaitingDecision({ ...base, decision: { text: '', at: 'now', outcome: 'deferred' } })).toBe(true);
    expect(isAwaitingDecision({ ...base, decision: { text: '', at: 'now', outcome: 'tickets' } })).toBe(false);
    expect(isAwaitingDecision({ followUpFrom: { taskId: '1', item: 'x' } })).toBe(false);
    expect(isAwaitingDecision(undefined)).toBe(false);
  });

  it('reads the question from metadata, else from the description', () => {
    expect(getDecisionQuestion({ followUpFrom: { taskId: '1', item: 'x', why: 'Pick one' } }, '')).toBe('Pick one');
    expect(getDecisionQuestion(undefined, 'a\n\n**Why this needs a decision:** Scope is unclear\nmore')).toBe('Scope is unclear');
    expect(getDecisionQuestion(undefined, 'nothing')).toBe('');
  });
});

describe('suggestions', () => {
  it('uses the suggestion only when the text is empty', () => {
    expect(resolveDecisionText('', 'Add X now')).toBe('Add X now');
    expect(resolveDecisionText('   ', 'Add X now')).toBe('Add X now');
    expect(resolveDecisionText('My own words', 'Add X now')).toBe('My own words');
    expect(resolveDecisionText('', undefined)).toBe('');
  });

  it('prefills saved text over the suggestion', () => {
    const followUpFrom = { taskId: 't', item: 'i', needsDecision: true, suggestion: 'Add X now' };
    expect(initialDecisionText({ followUpFrom })).toBe('Add X now');
    expect(initialDecisionText({ followUpFrom, decision: { text: 'Later', at: 'x', outcome: 'deferred' } })).toBe('Later');
  });

  it('normalizes the suggestion', () => {
    expect(normalizeSuggestion({ suggestion: ' Add X \u2014 now ' })).toBe('Add X, now');
    expect(normalizeSuggestion({ suggestion: 'a'.repeat(900) })).toHaveLength(500);
    expect(normalizeSuggestion(null)).toBe('');
  });
});
