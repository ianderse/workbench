/**
 * Follow-up tickets: the pure rules
 * =================================
 *
 * When a task reaches Human Review, the "needs your attention" items of its review summary that
 * describe work become new tickets. One read-only model call judges each item:
 *   - none:     only for information, no work
 *   - covered:  an open ticket already covers it (that ticket gets a note instead)
 *   - queue:    clear, bounded, in-scope work an engineer would just do (goes to the Queue)
 *   - planning: needs a product or design decision, changes scope, is risky or large (goes to
 *               Planning, which never starts on its own)
 * This module holds the schema, the prompt, the validation of the answer and the texts. Nothing
 * here touches the disk or a process; `main/follow-up-tickets.ts` applies the result.
 */
import type { ProjectSettings } from '../types/project';
import { isGroomableStatus, taskNumber } from './queue-grooming';

/** New tickets one reviewed task can create */
export const MAX_FOLLOW_UP_TICKETS = 4;
const MAX_COVERED_NOTES = 6;
const MAX_ITEM_CHARS = 300;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 3000;
const MAX_WHY_CHARS = 400;
const MAX_TICKET_DESCRIPTION_CHARS = 1200;

export type FollowUpAction = 'none' | 'covered' | 'queue' | 'planning';

/** Whether the project creates follow-up tickets (default on) */
export function isFollowUpTicketsEnabled(settings: Pick<ProjectSettings, 'followUpTickets'> | undefined): boolean {
  return settings?.followUpTickets !== false;
}

export const FOLLOW_UP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string', description: 'The needs-attention item, copied as given' },
          action: { type: 'string', enum: ['none', 'covered', 'queue', 'planning'] },
          coveredBy: { type: 'string', description: 'action covered: id of the open ticket that already covers it' },
          title: { type: 'string', description: 'actions queue and planning: short ticket title in sentence case, no trailing period' },
          description: { type: 'string', description: 'actions queue and planning: standalone description with acceptance criteria' },
          why: { type: 'string', description: 'One sentence: why this action' },
        },
        required: ['item', 'action', 'why'],
      },
    },
  },
  required: ['items'],
};

export const FOLLOW_UP_SYSTEM_PROMPT = `You turn the "needs your attention" items of a finished software ticket into follow-up tickets. The ticket just reached review. You do NOT write code and you do NOT change files. You may read the project, but you usually do not need to. Answer with the structured output only: one entry per item, in the same order.

For each item choose exactly one action:
- "none": the item is only for information (an assumption, a risk to be aware of, how something was checked) and describes no work. No ticket is made.
- "covered": one of the open tickets listed below already covers this work. Put its id in "coveredBy". It gets a note instead of a new ticket. Work listed under "already handed off" is covered by tickets that may not exist yet: answer "none" for it.
- "queue": clear, bounded, in-scope follow-up work an engineer would simply do without asking anyone, for example a missing test, a small cleanup the reviewer flagged, or a fix for a bug that was found. It starts on its own once the reviewed ticket is merged.
- "planning": the work needs a human to decide whether it should be done at all: a product or design decision, a change of scope, something risky or large, or something that contradicts the ticket's spec. It waits in Planning until the person decides.

For "queue" and "planning" give a short "title" (sentence case, no trailing period) and a standalone "description" that someone who has not seen the reviewed ticket can act on, with acceptance criteria. "why" is one plain sentence; for "planning" it tells the person what they have to decide.

Rules:
- When unsure between "queue" and "planning", choose "planning". When unsure between work and information, choose "none".
- Never create a ticket for work the reviewed ticket was asked to do and did, and never for something an open ticket covers.
- Use only ticket ids from the list below. Do not use em dashes or en dashes.`;

export interface FollowUpOpenTicket {
  id: string;
  title: string;
  /** Board status: backlog, queue, in_progress, ... */
  status: string;
  description?: string;
}

export interface FollowUpPromptInput {
  source: { id: string; title: string; description?: string; summary?: string; headline?: string; whatChanged?: string[] };
  needsAttention: readonly string[];
  openTickets: readonly FollowUpOpenTicket[];
  /** Work the source already handed off to tickets that may not exist yet (pending split proposal) */
  alreadySplitOff?: readonly string[];
}

function clip(text: string | undefined, max: number): string {
  const clean = (text ?? '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

const COLUMN: Record<string, string> = { backlog: 'Planning', queue: 'Queue', in_progress: 'In progress', ai_review: 'In progress' };

/** The user message: the finished ticket, its review items and the open tickets */
export function buildFollowUpPrompt(input: FollowUpPromptInput): string {
  const { source } = input;
  const parts: string[] = [];
  const reviewed = [
    `<reviewed_ticket id="${source.id}" title="${source.title.replace(/"/g, "'")}">`,
    `Description:\n${clip(source.description, 1500)}`,
    source.headline ? `Review summary: ${clip(source.headline, 300)}` : '',
    source.whatChanged?.length ? `What changed:\n${source.whatChanged.map((b) => `- ${clip(b, 220)}`).join('\n')}` : '',
    source.summary ? `Agent final notes:\n${clip(source.summary, 2000)}` : '',
    '</reviewed_ticket>',
  ]
    .filter(Boolean)
    .join('\n');
  parts.push(reviewed);
  parts.push(`Needs your attention items to judge:\n${input.needsAttention.map((item, i) => `${i + 1}. ${item}`).join('\n')}`);
  if (input.alreadySplitOff?.length) {
    parts.push(`Work this ticket already handed off to new tickets (treat as covered, answer "none"):\n${input.alreadySplitOff.map((t) => `- ${clip(t, 200)}`).join('\n')}`);
  }
  const tickets = input.openTickets
    .map(
      (t) =>
        `<ticket id="${t.id}" column="${COLUMN[t.status] ?? t.status}" title="${t.title.replace(/"/g, "'")}">\n${clip(t.description, MAX_TICKET_DESCRIPTION_CHARS)}\n</ticket>`
    )
    .join('\n');
  parts.push(`Open tickets (Planning, Queue, In progress):\n${tickets || '(none)'}`);
  return parts.join('\n\n');
}

export interface FollowUpTicketPlan {
  item: string;
  action: 'queue' | 'planning';
  title: string;
  description: string;
  why: string;
}

export interface FollowUpCoveredPlan {
  item: string;
  coveredBy: string;
  why: string;
}

export interface FollowUpResult {
  tickets: FollowUpTicketPlan[];
  covered: FollowUpCoveredPlan[];
}

export interface FollowUpContext {
  /** Ids of the open tickets the model was shown */
  openTicketIds: ReadonlySet<string>;
  /** Ids among them that may still take a note (Planning and the Queue) */
  noteableTicketIds: ReadonlySet<string>;
  /** The reviewed ticket is itself a follow-up: it may only create Planning tickets */
  sourceIsFollowUp: boolean;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n').slice(0, max).trim() : '';
}

/** Dashes the prompt forbids but a model sometimes writes anyway */
function noDashes(value: string): string {
  return value.replace(/\s*[—–]\s*/g, ', ');
}

/**
 * Validate the model's answer. Drops entries with an unknown action; `covered` needs a known open
 * ticket in Planning or the Queue (else it is dropped, no ticket is made for it); `queue` and
 * `planning` need a title and a description; a follow-up of a follow-up can only go to Planning;
 * at most 4 tickets (the first ones win) and one entry per item.
 */
export function normalizeFollowUpResult(raw: unknown, context: FollowUpContext): FollowUpResult {
  const result: FollowUpResult = { tickets: [], covered: [] };
  const list = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : undefined;
  if (!Array.isArray(list)) return result;
  const seenItems = new Set<string>();
  const coveredTickets = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const item = noDashes(text(e.item, MAX_ITEM_CHARS));
    if (!item) continue;
    const key = item.toLowerCase();
    if (seenItems.has(key)) continue;
    const why = noDashes(text(e.why, MAX_WHY_CHARS));

    if (e.action === 'covered') {
      const coveredBy = text(e.coveredBy, 200);
      if (!context.openTicketIds.has(coveredBy) || !context.noteableTicketIds.has(coveredBy)) continue;
      // One note per ticket
      if (coveredTickets.has(coveredBy) || result.covered.length >= MAX_COVERED_NOTES) continue;
      coveredTickets.add(coveredBy);
      seenItems.add(key);
      result.covered.push({ item, coveredBy, why });
      continue;
    }

    if (e.action !== 'queue' && e.action !== 'planning') continue;
    if (result.tickets.length >= MAX_FOLLOW_UP_TICKETS) continue;
    const title = noDashes(text(e.title, MAX_TITLE_CHARS)).replace(/\.+$/, '');
    const description = noDashes(text(e.description, MAX_DESCRIPTION_CHARS));
    if (!title || !description) continue;
    const action = e.action === 'queue' && context.sourceIsFollowUp ? 'planning' : e.action;
    seenItems.add(key);
    result.tickets.push({ item, action, title, description, why });
  }
  return result;
}

/** Board statuses of the open tickets the model is shown */
export function isOpenForFollowUp(status: string): boolean {
  return isGroomableStatus(status) || status === 'in_progress' || status === 'ai_review';
}

/** The description of a new follow-up ticket: the work, where it came from and, for Planning, what to decide */
export function buildFollowUpDescription(plan: FollowUpTicketPlan, sourceTaskId: string): string {
  const lines = [plan.description.trim(), '', '---', `**Follow-up from #${taskNumber(sourceTaskId)}.** The review flagged: ${plan.item}`];
  if (plan.action === 'planning') {
    lines.push('', `**Why this needs a decision:** ${plan.why || plan.item}`);
  }
  return lines.join('\n');
}

/** The note a ticket gets when the review of another task flagged work it already covers */
export function buildFollowUpNoteBlock(fromTaskId: string, note: string): string {
  return `\n\n---\n**Raised in the review of #${taskNumber(fromTaskId)}**\n${note.trim()}`;
}

/** The note text for a covered item */
export function buildCoveredNote(plan: FollowUpCoveredPlan): string {
  return plan.why ? `${plan.item} (${plan.why})` : plan.item;
}
