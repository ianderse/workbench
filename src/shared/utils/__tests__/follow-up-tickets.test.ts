import { describe, it, expect } from 'vitest';
import {
  buildFollowUpDescription,
  buildFollowUpPrompt,
  isFollowUpTicketsEnabled,
  normalizeFollowUpResult,
  type FollowUpContext,
} from '../follow-up-tickets';

const ctx = (extra: Partial<FollowUpContext> = {}): FollowUpContext => ({
  openTicketIds: new Set(['002-map', '003-mobs', '005-ui']),
  noteableTicketIds: new Set(['002-map', '003-mobs']),
  sourceIsFollowUp: false,
  ...extra,
});

const ticket = (item: string, action = 'queue', extra: Record<string, unknown> = {}) => ({
  item,
  action,
  title: `Do ${item}`,
  description: `Description for ${item}`,
  why: 'because',
  ...extra,
});

describe('normalizeFollowUpResult', () => {
  it('keeps queue and planning tickets and covered notes, and ignores none', () => {
    const result = normalizeFollowUpResult(
      { items: [ticket('a'), ticket('b', 'planning'), { item: 'c', action: 'covered', coveredBy: '002-map', why: 'w' }, { item: 'd', action: 'none', why: 'fyi' }] },
      ctx()
    );
    expect(result.tickets.map((t) => [t.item, t.action])).toEqual([['a', 'queue'], ['b', 'planning']]);
    expect(result.covered).toEqual([{ item: 'c', coveredBy: '002-map', why: 'w' }]);
  });

  it('keeps a clipped suggestion on planning tickets only and removes dashes', () => {
    const long = 'Add X now; '.repeat(100);
    const result = normalizeFollowUpResult(
      {
        items: [
          ticket('a', 'planning', { suggestion: '  Add X now \u2014 defer Y  ' }),
          ticket('b', 'queue', { suggestion: 'ignored' }),
          ticket('c', 'planning', { suggestion: long }),
          ticket('d', 'planning'),
        ],
      },
      ctx()
    );
    const by = Object.fromEntries(result.tickets.map((t) => [t.item, t.suggestion]));
    expect(by.a).toBe('Add X now, defer Y');
    expect(by.b).toBe('');
    expect((by.c ?? '').length).toBeLessThanOrEqual(500);
    expect(by.d).toBe('');
  });

  it('requires a title and a description for queue and planning', () => {
    const result = normalizeFollowUpResult(
      { items: [ticket('a', 'queue', { title: '' }), ticket('b', 'planning', { description: '  ' }), ticket('c')] },
      ctx()
    );
    expect(result.tickets.map((t) => t.item)).toEqual(['c']);
  });

  it('drops covered entries with an unknown ticket or one that cannot take a note', () => {
    const result = normalizeFollowUpResult(
      {
        items: [
          { item: 'a', action: 'covered', coveredBy: 'nope', why: '' },
          { item: 'b', action: 'covered', coveredBy: '005-ui', why: '' },
          { item: 'c', action: 'covered', why: '' },
          { item: 'd', action: 'covered', coveredBy: '003-mobs', why: '' },
        ],
      },
      ctx()
    );
    expect(result.covered.map((c) => c.item)).toEqual(['d']);
    expect(result.tickets).toEqual([]);
  });

  it('caps the tickets at 4 and keeps the first ones', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((i) => ticket(i));
    expect(normalizeFollowUpResult({ items }, ctx()).tickets.map((t) => t.item)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('downgrades queue to planning for a follow-up of a follow-up', () => {
    const result = normalizeFollowUpResult({ items: [ticket('a', 'queue'), ticket('b', 'planning')] }, ctx({ sourceIsFollowUp: true }));
    expect(result.tickets.map((t) => t.action)).toEqual(['planning', 'planning']);
  });

  it('drops duplicate items, unknown actions and garbage', () => {
    expect(normalizeFollowUpResult({ items: [ticket('a'), ticket('A'), ticket('b', 'later')] }, ctx()).tickets.map((t) => t.item)).toEqual(['a']);
    expect(normalizeFollowUpResult(null, ctx())).toEqual({ tickets: [], covered: [] });
    expect(normalizeFollowUpResult({ items: 'x' }, ctx())).toEqual({ tickets: [], covered: [] });
    expect(normalizeFollowUpResult({ items: [null, 3, {}] }, ctx())).toEqual({ tickets: [], covered: [] });
  });

  it('removes dashes the model wrote anyway', () => {
    const [t] = normalizeFollowUpResult({ items: [ticket('x', 'queue', { title: 'Add tests — fast', description: 'a — b' })] }, ctx()).tickets;
    expect(t.title).toBe('Add tests, fast');
    expect(t.description).toBe('a, b');
  });
});

describe('texts and settings', () => {
  it('is on unless the setting is false', () => {
    expect(isFollowUpTicketsEnabled(undefined)).toBe(true);
    expect(isFollowUpTicketsEnabled({})).toBe(true);
    expect(isFollowUpTicketsEnabled({ followUpTickets: false })).toBe(false);
  });

  it('adds the origin and, for Planning, why a decision is needed', () => {
    const base = { item: 'Retry is untested', action: 'planning' as const, title: 't', description: 'Do it', why: 'It changes the API' };
    expect(buildFollowUpDescription(base, '014-feature')).toContain('Follow-up from #014');
    expect(buildFollowUpDescription(base, '014-feature')).toContain('**Why this needs a decision:** It changes the API');
    expect(buildFollowUpDescription({ ...base, action: 'queue' }, '014-feature')).not.toContain('Why this needs a decision');
  });

  it('lists the items and the open tickets in the prompt', () => {
    const prompt = buildFollowUpPrompt({
      source: { id: '014-feature', title: 'Feature' },
      needsAttention: ['One', 'Two'],
      openTickets: [{ id: '002-map', title: 'Map', status: 'queue', description: 'd' }],
      alreadySplitOff: ['Docs'],
    });
    expect(prompt).toContain('1. One');
    expect(prompt).toContain('2. Two');
    expect(prompt).toContain('<ticket id="002-map" column="Queue"');
    expect(prompt).toContain('- Docs');
  });
});
