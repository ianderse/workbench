/**
 * Break into tasks
 * ================
 *
 * One structured, read-only model call turns a big prompt (and the specs it points at) into
 * several self-contained task descriptions with dependencies. The model call goes through
 * `runClaudeText()` (Claude Code or OMP, per the backend setting); `normalizeBreakdown()` is the
 * pure validation of what comes back.
 */
import type { AppSettings } from '../shared/types/settings';
import type { BreakdownTask, OpenTicketRef, TaskBreakdown } from '../shared/types/task-breakdown';
import { breakDependencyCycles, sortByDependencies } from '../shared/utils/task-breakdown-order';
import { READ_ONLY_TOOLS, runClaudeText } from './claude-code/run-text';
import { resolveClaudeCodeTaskSettings } from './claude-code/settings';
import { readSettingsFile } from './settings-utils';
import type { RunProgress } from '../shared/utils/run-progress';

export const MIN_BREAKDOWN_TASKS = 2;
export const MAX_BREAKDOWN_TASKS = 12;
const MAX_OPEN_TICKETS_IN_PROMPT = 60;

const BREAKDOWN_SYSTEM_PROMPT = `You split a large piece of software work into a set of tasks for autonomous coding agents. You do NOT do the work.
Read the request, and read the files it references (specs, docs, plans) and, briefly, the parts of the project it touches.

Rules:
- Break the work into independently reviewable, mergeable increments, listed in build order.
- Every task must leave the project building and its tests passing once merged.
- Prefer fewer, coherent tasks over many tiny ones: between ${MIN_BREAKDOWN_TASKS} and ${MAX_BREAKDOWN_TASKS} tasks. Do not split work that is naturally one change.
- Each task runs in a separate session that has no memory of the others and starts from the project's base branch. Write each description so it stands alone: what to build, which spec files and sections to follow (name the paths), the relevant constraints from the request, and concrete acceptance criteria.
- dependsOn lists the keys of new tasks whose code this task needs, and the ids of existing open tickets (listed in <open_tickets>, when there are any) whose code this task needs and that are not merged yet. Add a dependency only when it is real; tasks that can be built independently must not depend on each other. A task that needs the result of an open ticket must depend on its id, or it would start before that ticket is merged.
- key is a short id such as "t1", "t2". title is short, in sentence case, with no trailing period.

Spend a limited number of tool calls exploring. Answer with the structured output only.`;

const BREAKDOWN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_BREAKDOWN_TASKS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', description: 'Short id such as "t1"' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Self-contained: what to build, which spec sections, acceptance criteria' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of new tasks, or ids of open tickets, that must be merged first' },
        },
        required: ['key', 'title', 'description', 'dependsOn'],
      },
    },
  },
  required: ['tasks'],
};

/**
 * Clean up a model's breakdown: drop malformed tasks, make keys unique, drop unknown and self
 * dependencies, and break cycles by dropping the edge that closes one. Throws when no task is left.
 * A dependency may also name an existing open ticket (by id, or its number such as "#005"): it is kept
 * in `dependsOnExisting`. Ids of tickets that are done, archived or unknown are dropped (a ticket
 * that is merged already is satisfied).
 */
export function normalizeBreakdown(raw: unknown, openTickets: readonly OpenTicketRef[] = []): TaskBreakdown {
  const rawTasks = (raw as { tasks?: unknown } | null | undefined)?.tasks;
  if (!Array.isArray(rawTasks)) throw new Error('The model returned no tasks');

  const usedKeys = new Set<string>();
  const tasks: BreakdownTask[] = [];
  // Original key -> unique key (a repeated key refers to its first task)
  const keyMap = new Map<string, string>();

  for (const item of rawTasks.slice(0, MAX_BREAKDOWN_TASKS)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim().replace(/\.$/, '') : '';
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    if (!title && !description) continue;

    const originalKey = typeof r.key === 'string' ? r.key.trim() : '';
    let key = originalKey || `t${tasks.length + 1}`;
    if (usedKeys.has(key)) {
      let n = tasks.length + 1;
      while (usedKeys.has(`t${n}`)) n += 1;
      key = `t${n}`;
    } else if (originalKey) {
      keyMap.set(originalKey, key);
    }
    usedKeys.add(key);
    tasks.push({
      key,
      title: title || description.split('\n')[0].slice(0, 80),
      description: description || title,
      dependsOn: Array.isArray(r.dependsOn)
        ? r.dependsOn.filter((d): d is string => typeof d === 'string').map((d) => d.trim())
        : [],
    });
  }

  if (tasks.length === 0) throw new Error('The model returned no usable tasks');

  // Existing open tickets by id and by number ("005" / "#005" when only one ticket has it)
  const openIds = new Set(openTickets.map((t) => t.id));
  const byNumber = new Map<number, string[]>();
  for (const ticket of openTickets) {
    const num = /^(\d+)/.exec(ticket.id)?.[1];
    if (num) byNumber.set(Number(num), [...(byNumber.get(Number(num)) ?? []), ticket.id]);
  }
  const resolveExisting = (dep: string): string | undefined => {
    if (openIds.has(dep)) return dep;
    const num = /^#?(\d+)$/.exec(dep)?.[1];
    const ids = num ? byNumber.get(Number(num)) : undefined;
    return ids?.length === 1 ? ids[0] : undefined;
  };

  // Unknown and self dependencies out, duplicates out; existing tickets split off
  for (const task of tasks) {
    const seen = new Set<string>();
    const existing = new Set<string>();
    task.dependsOn = task.dependsOn
      .map((d) => keyMap.get(d) ?? d)
      .filter((d) => {
        if (d === task.key || seen.has(d)) return false;
        if (usedKeys.has(d)) {
          seen.add(d);
          return true;
        }
        const ticket = resolveExisting(d);
        if (ticket) existing.add(ticket);
        return false;
      });
    task.dependsOnExisting = Array.from(existing);
  }

  // Cycles among the new tasks: drop the edge that would close one
  breakDependencyCycles(tasks);

  return { tasks: sortByDependencies(tasks), openTickets: [...openTickets] };
}

export interface BreakDownInput {
  projectPath: string;
  description: string;
  /** Names of the files attached to the prompt (the model sees the names, not the bytes) */
  attachmentNames?: string[];
  /** The project's open tickets, which the new tasks can depend on */
  openTickets?: OpenTicketRef[];
  /** Live progress of the model run */
  onProgress?: (progress: RunProgress) => void;
  abortSignal?: AbortSignal;
}

/** Ask the model to split a prompt into dependent tasks */
export async function breakDownTask(input: BreakDownInput): Promise<TaskBreakdown> {
  const settings = (readSettingsFile() ?? {}) as Partial<AppSettings>;
  const { triageModel } = resolveClaudeCodeTaskSettings(settings.claudeCodeTasks);

  const attachments = input.attachmentNames?.length
    ? `\n\nThe request has ${input.attachmentNames.length} attached file(s): ${input.attachmentNames.join(', ')}.`
    : '';
  const result = await runClaudeText({
    prompt: `<request>\n${input.description}\n</request>${attachments}${formatOpenTickets(input.openTickets)}`,
    appendSystemPrompt: BREAKDOWN_SYSTEM_PROMPT,
    model: triageModel,
    effort: 'medium',
    jsonSchema: BREAKDOWN_SCHEMA,
    cwd: input.projectPath,
    usage: { job: 'breakdown' },
    tools: READ_ONLY_TOOLS,
    maxTurns: 30,
    // Local models are slow; OMP multiplies this
    timeoutMs: 10 * 60 * 1000,
    abortSignal: input.abortSignal,
    onProgress: input.onProgress,
  });
  return normalizeBreakdown(result.structured ?? tryParseJson(result.text), input.openTickets ?? []);
}

/** The open tickets as a prompt section ("" when there are none) */
export function formatOpenTickets(tickets: readonly OpenTicketRef[] | undefined): string {
  if (!tickets || tickets.length === 0) return '';
  const lines = tickets
    .slice(0, MAX_OPEN_TICKETS_IN_PROMPT)
    .map((t) => `- id: ${t.id} | status: ${t.status} | title: ${t.title}${t.description ? ` | ${t.description}` : ''}`);
  return `\n\n<open_tickets>\nTickets that exist already and are not merged yet. Their code is not on the base branch until they are merged.\n${lines.join('\n')}\n</open_tickets>`;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
