/**
 * Decision tickets: the pure rules
 * ================================
 *
 * A follow-up ticket with `followUpFrom.needsDecision` asks the person to decide something. The
 * "Your decision" panel takes their answer in free text; one read-only model call turns it into
 * 0..4 implementation tickets plus a short record of what was decided per item. This module holds
 * the schema, the prompt, the validation of the answer and the texts. Nothing here touches the
 * disk or a process; `main/decision-tickets.ts` applies the result.
 */
import type { TaskMetadata, TaskSourceDecision } from '../types/task';
import { taskNumber } from './queue-grooming';
import { MAX_SUGGESTION_CHARS } from './follow-up-tickets';

/** New tickets one decision can create */
export const MAX_DECISION_TICKETS = 4;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 3000;
const MAX_RECORD_CHARS = 2000;
const MAX_TEXT_CHARS = 4000;
const MAX_TICKET_DESCRIPTION_CHARS = 1000;

export type DecisionOutcome = 'tickets' | 'deferred' | 'rejected';

export type DecisionAction = 'tickets' | 'defer' | 'reject';

/** What deciding a ticket did */
export interface DecisionData {
  /** 'none': the answer asked for no work now, nothing changed */
  outcome: DecisionOutcome | 'none';
  /** Tickets made, in order */
  created: Array<{ taskId: string; queued: boolean }>;
  /** What the model recorded per item */
  decisionRecord: string;
}

export const DECISION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Short ticket title in sentence case, no trailing period' },
          description: { type: 'string', description: 'Standalone description with acceptance criteria' },
          queue: { type: 'boolean', description: 'true to put the ticket in the Queue; false only when the person asked to just plan it' },
        },
        required: ['title', 'description', 'queue'],
      },
    },
    decisionRecord: {
      type: 'string',
      description: 'Short markdown list with one line per decided item: add, defer or reject, with the person\'s reason',
    },
  },
  required: ['tickets', 'decisionRecord'],
};

export const DECISION_SYSTEM_PROMPT = `You turn a person's decision into implementation tickets. A ticket in Planning asked them to decide something; they have now answered in their own words. You do NOT write code and you do NOT change files. You may read the project, but you usually do not need to. Answer with the structured output only.

Rules:
- Create tickets only for what the person said to do now. Anything they deferred or rejected produces no ticket.
- One ticket per piece of work that can be built and checked on its own, at most ${MAX_DECISION_TICKETS}. Merge tiny related pieces. Never create a ticket that an open ticket already covers.
- Each ticket gets a short "title" (sentence case, no trailing period) and a standalone "description" that someone who has not seen the decision ticket can act on, with acceptance criteria. Stay within what the person said; do not add scope.
- "queue" is true unless the person asked to just plan the work, to hold it or to look at it first.
- "decisionRecord" is a short markdown bullet list with one line per item the decision ticket asks about: "add", "defer" or "reject", with the person's rationale in their words. If the answer does not cover an item, say it was not decided.
- If the person's answer asks for no work now, return an empty "tickets" list.
- Do not use em dashes or en dashes.`;

export interface DecisionOpenTicket {
  id: string;
  title: string;
  status: string;
  description?: string;
}

export interface DecisionPromptInput {
  ticket: { id: string; title: string; description?: string };
  /** The reviewed task the decision came from, when known */
  source?: { id: string; title: string; headline?: string; whatChanged?: string[]; summary?: string };
  openTickets: readonly DecisionOpenTicket[];
  decision: string;
}

function clip(text: string | undefined, max: number): string {
  const clean = (text ?? '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

const COLUMN: Record<string, string> = { backlog: 'Planning', queue: 'Queue', in_progress: 'In progress', ai_review: 'In progress' };

/** The user message: the decision ticket, its source task, the open tickets and the person's answer */
export function buildDecisionPrompt(input: DecisionPromptInput): string {
  const parts: string[] = [];
  parts.push(
    `<decision_ticket id="${input.ticket.id}" title="${input.ticket.title.replace(/"/g, "'")}">\n${clip(input.ticket.description, MAX_DESCRIPTION_CHARS)}\n</decision_ticket>`
  );
  if (input.source) {
    const { source } = input;
    parts.push(
      [
        `<source_task id="${source.id}" title="${source.title.replace(/"/g, "'")}">`,
        source.headline ? `Review summary: ${clip(source.headline, 300)}` : '',
        source.whatChanged?.length ? `What changed:\n${source.whatChanged.map((b) => `- ${clip(b, 220)}`).join('\n')}` : '',
        source.summary ? `Agent final notes:\n${clip(source.summary, 2000)}` : '',
        '</source_task>',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  const tickets = input.openTickets
    .map(
      (t) =>
        `<ticket id="${t.id}" column="${COLUMN[t.status] ?? t.status}" title="${t.title.replace(/"/g, "'")}">\n${clip(t.description, MAX_TICKET_DESCRIPTION_CHARS)}\n</ticket>`
    )
    .join('\n');
  parts.push(`Open tickets (Planning, Queue, In progress):\n${tickets || '(none)'}`);
  parts.push(`<person_decision>\n${clip(input.decision, MAX_TEXT_CHARS)}\n</person_decision>`);
  return parts.join('\n\n');
}

export interface DecisionTicketPlan {
  title: string;
  description: string;
  queue: boolean;
}

export interface DecisionResult {
  tickets: DecisionTicketPlan[];
  decisionRecord: string;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n').slice(0, max).trim() : '';
}

/** Dashes the prompt forbids but a model sometimes writes anyway */
function noDashes(value: string): string {
  return value.replace(/\s*[—–]\s*/g, ', ');
}

/**
 * Validate the model's answer: at most 4 tickets, each with a title and a description (others are
 * dropped), duplicate titles dropped, `queue` defaults to true unless it is `false`, a record
 * that is a string (else empty). Never throws; garbage gives no tickets and no record.
 */
export function normalizeDecisionResult(raw: unknown): DecisionResult {
  const result: DecisionResult = { tickets: [], decisionRecord: '' };
  if (!raw || typeof raw !== 'object') return result;
  const r = raw as { tickets?: unknown; decisionRecord?: unknown };
  result.decisionRecord = noDashes(text(r.decisionRecord, MAX_RECORD_CHARS));
  if (!Array.isArray(r.tickets)) return result;
  const seen = new Set<string>();
  for (const entry of r.tickets) {
    if (result.tickets.length >= MAX_DECISION_TICKETS) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = noDashes(text(e.title, MAX_TITLE_CHARS)).replace(/\.+$/, '');
    const description = noDashes(text(e.description, MAX_DESCRIPTION_CHARS));
    if (!title || !description) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.tickets.push({ title, description, queue: e.queue !== false });
  }
  return result;
}

/** The description of a ticket made from a decision: the work and where it came from */
export function buildDecisionTicketDescription(plan: DecisionTicketPlan, decisionTaskId: string, source?: TaskSourceDecision): string {
  const lines = [plan.description.trim(), '', '---', `**From the decision on #${taskNumber(decisionTaskId)}.**`];
  if (source) lines.push('', '## Originating recorded decision',
    `Source task: ${source.taskId}; project: ${source.projectId}.`,
    `Recorded decision time: ${source.at}. Outcome: ${source.outcome}.`,
    'The exact recorded words below retain their original scope. This is not a new approval of this task or evidence of a separate review session.',
    '', source.text);
  return lines.join('\n');
}

/** The block appended to the decision ticket's description */
export function buildDecisionBlock(outcome: DecisionOutcome, text: string, record = ''): string {
  const lines = ['', '', '---', '## Decision'];
  if (outcome === 'deferred') lines.push('Deferred for now.');
  if (outcome === 'rejected') lines.push('Rejected.');
  if (record.trim()) lines.push('', record.trim());
  if (text.trim()) lines.push('', `**Your words:** ${text.trim()}`);
  return lines.join('\n');
}

/** Whether a ticket is waiting for the person's decision (a deferred one can be decided again) */
export function isAwaitingDecision(metadata: Pick<TaskMetadata, 'followUpFrom' | 'decision'> | undefined): boolean {
  if (metadata?.followUpFrom?.needsDecision !== true) return false;
  return !metadata.decision || metadata.decision.outcome === 'deferred';
}

/** What the person has to decide: the stored reason, else the one written into older descriptions */
export function getDecisionQuestion(metadata: TaskMetadata | undefined, description: string | undefined): string {
  const stored = metadata?.followUpFrom?.why?.trim();
  if (stored) return stored;
  const match = /\*\*Why this needs a decision:\*\*\s*([^\n]+)/.exec(description ?? '');
  return match?.[1]?.trim() ?? '';
}

/** The stored suggestion of a needs-decision ticket ('' when there is none) */
export function getDecisionSuggestion(metadata: TaskMetadata | undefined): string {
  return metadata?.followUpFrom?.suggestion?.trim() ?? '';
}

/**
 * The words that get turned into tickets: what the person wrote, else the suggestion. Their own
 * text always wins, even when it differs from the suggestion.
 */
export function resolveDecisionText(text: string, suggestion: string | undefined): string {
  return text.trim() || (suggestion ?? '').trim();
}

/** What the textarea starts with: the saved text of a deferred ticket wins over the suggestion */
export function initialDecisionText(metadata: TaskMetadata | undefined): string {
  return metadata?.decision?.text?.trim() ? metadata.decision.text : getDecisionSuggestion(metadata);
}

export const SUGGEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suggestion: {
      type: 'string',
      description: 'The recommended decision, written the way the person would type it: what to add now, what to defer and what to reject, each with a short reason',
    },
  },
  required: ['suggestion'],
};

export const SUGGEST_SYSTEM_PROMPT = `You recommend a decision. A ticket in Planning asks a person to decide something. You do NOT write code and you do NOT change files. You may read the project, but you usually do not need to. Answer with the structured output only.

Write "suggestion" as the person would type their own answer: one or two short sentences, for example "Add X now; defer Y until slice 2; reject Z because ...". Name the concrete pieces of work the ticket lists, stay tied to the spec and the reviewed task, and give a brief reason for each defer or reject. Do not hedge, do not ask questions and do not use em dashes or en dashes. Maximum ${MAX_SUGGESTION_CHARS} characters.`;

export interface SuggestPromptInput {
  ticket: { id: string; title: string; description?: string; question?: string };
  source?: { id: string; title: string; description?: string; headline?: string; whatChanged?: string[]; summary?: string };
}

/** The user message: the decision ticket and the task it came from */
export function buildSuggestPrompt(input: SuggestPromptInput): string {
  const parts = [
    `<decision_ticket id="${input.ticket.id}" title="${input.ticket.title.replace(/"/g, "'")}">\n${clip(input.ticket.description, MAX_DESCRIPTION_CHARS)}\n</decision_ticket>`,
  ];
  if (input.ticket.question) parts.push(`What needs deciding: ${clip(input.ticket.question, 400)}`);
  if (input.source) {
    const { source } = input;
    parts.push(
      [
        `<source_task id="${source.id}" title="${source.title.replace(/"/g, "'")}">`,
        source.description ? `Spec:\n${clip(source.description, 1500)}` : '',
        source.headline ? `Review summary: ${clip(source.headline, 300)}` : '',
        source.whatChanged?.length ? `What changed:\n${source.whatChanged.map((b) => `- ${clip(b, 220)}`).join('\n')}` : '',
        source.summary ? `Agent final notes:\n${clip(source.summary, 2000)}` : '',
        '</source_task>',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return parts.join('\n\n');
}

/** The model's suggestion, clipped; '' when it gave none */
export function normalizeSuggestion(raw: unknown): string {
  const value = raw && typeof raw === 'object' ? (raw as { suggestion?: unknown }).suggestion : undefined;
  return noDashes(text(value, MAX_SUGGESTION_CHARS));
}
