/**
 * Task splitting: the pure rules
 * ==============================
 *
 * The agent working a ticket can move part of its scope into new tickets: at the plan step
 * (structured `split` field) or at the end of implementing (a `## Deferred` list in its final
 * answer). This module validates what the model sends back, writes the reduced description and the
 * note, and works out how the tickets that waited on the original are rewired. Nothing here
 * touches the disk or a process; `main/task-split.ts` applies the plan.
 */
import type { ProjectSettings } from '../types/project';
import type { SplitPiece } from '../types/queue-grooming';
import { isGroomableStatus, taskNumber, type GroomTask } from './queue-grooming';
import { resolveAutonomousConfig } from './autonomous';

export type SelfSplitMode = 'off' | 'propose' | 'auto';

/** New tickets a split creates (the task itself keeps the rest, so a split makes 2 to 5 tickets) */
export const MIN_SPLIT_PIECES = 1;
export const MAX_SPLIT_PIECES = 4;
const MAX_TITLE_CHARS = 120;
const MAX_PIECE_DESCRIPTION_CHARS = 4000;
const MAX_KEEP_SCOPE_CHARS = 4000;
const MAX_REASON_CHARS = 400;
const MAX_DEFERRED_ITEMS = 8;
const MAX_DEFERRED_ITEM_CHARS = 400;

/** The project's split mode: the setting, else auto while autonomous mode is on, else propose */
export function resolveSelfSplit(settings: Partial<ProjectSettings> | undefined): SelfSplitMode {
  const value = settings?.selfSplit;
  if (value === 'off' || value === 'propose' || value === 'auto') return value;
  return resolveAutonomousConfig(settings).enabled ? 'auto' : 'propose';
}

/**
 * Whether a task may split now: the mode is not off, the ticket was not made by a split (depth 1)
 * and it has not split before.
 */
export function canTaskSplit(mode: SelfSplitMode, metadata: { splitFrom?: string; splitInto?: unknown } | undefined): boolean {
  return mode !== 'off' && !metadata?.splitFrom && !metadata?.splitInto;
}

// =============================================================================
// Plan step: schema, prompt, normalisation
// =============================================================================

/** The `split` property of the plan step's structured output */
export const SPLIT_SCHEMA_PROPERTY: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'Only when the ticket is clearly too large for one reviewable change. Leave it out otherwise.',
  properties: {
    reason: { type: 'string', description: 'Why the ticket is split' },
    keepScope: { type: 'string', description: 'What this ticket will still do (the plan covers only this)' },
    newTickets: {
      type: 'array',
      minItems: MIN_SPLIT_PIECES,
      maxItems: MAX_SPLIT_PIECES,
      description: 'The pieces moved into new tickets, in the order they should be done',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Short, sentence case, no trailing period' },
          description: { type: 'string', description: 'Self-contained: the agent working it sees nothing else' },
          reason: { type: 'string' },
        },
        required: ['title', 'description', 'reason'],
      },
    },
  },
  required: ['reason', 'keepScope', 'newTickets'],
};

/** The plan step's output schema; the split option is left out when splitting is off or not allowed */
export function buildPlanSchema(splitAllowed: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      plan: { type: 'string', description: 'The implementation plan in Markdown' },
      ...(splitAllowed ? { split: SPLIT_SCHEMA_PROPERTY } : {}),
    },
    required: ['plan'],
  };
}

/** Added to the plan prompt when the task may split. `local` spells it out for local models. */
export function splitPlanPrompt(local: boolean): string {
  if (!local) {
    return `\nOnly if this ticket is clearly too large for one reviewable change (it spans many unrelated areas), fill "split": keepScope is what this ticket still does, and ${MIN_SPLIT_PIECES} to ${MAX_SPLIT_PIECES} self-contained newTickets take the rest. Every piece must leave the project building and passing its tests. Then plan only keepScope. Otherwise leave "split" out.`;
  }
  return `

Splitting this ticket (optional, rare):
- Most tickets must NOT be split. Leave the "split" field out unless the ticket is clearly too large for one reviewable change, for example it touches many unrelated areas.
- When you do split: "keepScope" says what THIS ticket will still do, and "newTickets" holds ${MIN_SPLIT_PIECES} to ${MAX_SPLIT_PIECES} new tickets for the rest, in the order they should be done. Each new ticket needs a short title and a self-contained description (the agent that gets it sees nothing else: name files, behaviour and acceptance criteria).
- Every piece, including the kept one, must leave the project building and its tests passing.
- When you split, write the "plan" for keepScope only.`;
}

export interface NormalizedSplit {
  keepScope: string;
  pieces: SplitPiece[];
  reason: string;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n').slice(0, max).trim() : '';
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * Clean up the model's `split` field. Null (no split) when splitting is not allowed for the task,
 * the field is missing or malformed, there is nothing kept, or no valid piece remains. Pieces need
 * a title and a description; repeated titles are dropped; at most `MAX_SPLIT_PIECES` stay.
 */
export function normalizeSplit(raw: unknown, allowed: boolean): NormalizedSplit | null {
  if (!allowed || !raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const keepScope = cleanText(record.keepScope, MAX_KEEP_SCOPE_CHARS);
  if (!keepScope || !Array.isArray(record.newTickets)) return null;
  const pieces: SplitPiece[] = [];
  for (const item of record.newTickets) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = cleanText(r.title, MAX_TITLE_CHARS).replace(/\.+$/, '');
    const description = cleanText(r.description, MAX_PIECE_DESCRIPTION_CHARS);
    if (!title || !description) continue;
    if (pieces.some((p) => sameTitle(p.title, title))) continue;
    pieces.push({ title, description, reason: cleanText(r.reason, MAX_REASON_CHARS) });
    if (pieces.length === MAX_SPLIT_PIECES) break;
  }
  if (pieces.length < MIN_SPLIT_PIECES) return null;
  return { keepScope, pieces, reason: cleanText(record.reason, MAX_REASON_CHARS) };
}

// =============================================================================
// End of implementing: the Deferred section
// =============================================================================

/** Added to the implement prompt when the task may split */
export function deferredPrompt(): string {
  return `

If you deliberately left out part of this task because it is too big for this change, end your final answer with a section headed exactly "## Deferred" followed by a bullet list ("- ...") of what is still to do, each item self-contained. Everything else must be done and committed. Leave the section out when nothing was deferred.`;
}

const DEFERRED_HEADING = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*deferred(?:\s+(?:work|items?|scope|tasks?))?\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.*\S)\s*$/;
const NOTHING = /^(?:none|n\/a|nothing|no(?:thing)? (?:was )?deferred|-)\.?$/i;

/**
 * The "## Deferred" list at the end of a final answer, tolerant of how local models write it
 * (any heading level, bold, trailing colon, "-", "*" or numbered items). `rest` is the answer
 * without that section. The last such section wins.
 */
export function parseDeferredSection(text: string): { items: string[]; rest: string } {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (DEFERRED_HEADING.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return { items: [], rest: text ?? '' };

  const items: string[] = [];
  let end = start + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    const bullet = BULLET.exec(line);
    if (bullet) {
      items.push(bullet[1].trim());
    } else if (!line.trim()) {
      continue;
    } else if (/^\s{0,3}#{1,6}\s/.test(line)) {
      break;
    } else if (/^\s+\S/.test(line) && items.length > 0) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else if (items.length > 0) {
      break;
    }
  }
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\s+$/, '');
  const cleaned = items
    .map((item) => item.replace(/\s+/g, ' ').slice(0, MAX_DEFERRED_ITEM_CHARS).trim())
    .filter((item) => item && !NOTHING.test(item))
    .slice(0, MAX_DEFERRED_ITEMS);
  return { items: cleaned, rest };
}

/** The follow-up ticket for deferred items, as a split request (the task keeps `doneSummary`) */
export function deferredToSplit(
  task: { id: string; title: string },
  items: readonly string[],
  doneSummary: string
): NormalizedSplit | null {
  if (items.length === 0) return null;
  const list = items.map((item) => `- ${item}`).join('\n');
  const summary = doneSummary.trim();
  const kept = summary
    ? `This ticket was implemented without the work moved to a follow-up ticket. The agent's summary of what was done:\n\n${summary}`
    : `The part of "${task.title}" that was implemented, without the work moved to a follow-up ticket.`;
  return {
    keepScope: kept.slice(0, MAX_KEEP_SCOPE_CHARS),
    reason: 'The agent deliberately left this work out at the end of implementing',
    pieces: [
      {
        title: `Remaining from ${task.title}`.slice(0, MAX_TITLE_CHARS),
        description: `Work left over from "${task.title}" (#${taskNumber(task.id)}), which was implemented without it. The rest of that ticket is already done.\n\nStill to do:\n${list}`,
        reason: 'Deferred work',
      },
    ],
  };
}

// =============================================================================
// Applying a split
// =============================================================================

/** yyyy-mm-dd in local time */
export function formatSplitDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Split on 2026-10-24: moved "A" and "B" to #008 and #009" */
export function buildSplitNote(now: Date, pieces: readonly Pick<SplitPiece, 'title'>[], newTaskIds: readonly string[]): string {
  const titles = pieces.map((p) => `"${p.title}"`);
  const numbers = newTaskIds.map((id) => `#${taskNumber(id)}`);
  return `Split on ${formatSplitDate(now)}: moved ${joinList(titles)} to ${joinList(numbers)}`;
}

/** The text appended to the reduced description for the note (the note's `block`) */
export function buildSplitNoteBlock(note: string): string {
  return `\n\n---\n**Split**\n${note.trim()}`;
}

/** The reduced scope, with the original text kept in a collapsed block */
export function buildSplitDescription(keepScope: string, originalDescription: string): string {
  const original = originalDescription.trim();
  const kept = keepScope.trim();
  if (!original) return kept;
  return `${kept}\n\n<details>\n<summary>Original scope (now split, do not implement the moved parts)</summary>\n\n${original}\n\n</details>`;
}

/**
 * Tickets that waited on the split task and still can be rewired (Planning and Queue, not
 * archived): each now waits on the last new piece, so it starts only when the full original scope
 * is done. Tickets that already run or merged keep their dependencies. Returns the new
 * dependency list per ticket.
 */
export function planSplitRewire(
  tasks: readonly GroomTask[],
  splitTaskId: string,
  lastPieceId: string
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.archived || task.id === splitTaskId || task.id === lastPieceId) continue;
    if (!isGroomableStatus(task.status) || !task.dependsOn.includes(splitTaskId)) continue;
    const next: string[] = [];
    for (const dep of task.dependsOn) {
      const replacement = dep === splitTaskId ? lastPieceId : dep;
      if (!next.includes(replacement)) next.push(replacement);
    }
    result[task.id] = next;
  }
  return result;
}

/** Dependencies of piece `index`: the split task for the first, the previous piece after that */
export function pieceDependsOn(splitTaskId: string, createdIds: readonly string[], index: number): string[] {
  return [index === 0 ? splitTaskId : createdIds[index - 1]];
}
