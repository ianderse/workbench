/**
 * Decision tickets
 * ================
 *
 * A follow-up ticket that needs a decision (`followUpFrom.needsDecision`) is answered by the person
 * in the task dialog's "Your decision" panel:
 *   - tickets:  one background, read-only model call turns their words into 0..4 implementation
 *               tickets (see shared/utils/decision-tickets.ts); the decision ticket records the
 *               decision and moves to Done (it never ran, so it has no worktree to merge)
 *   - deferred: the note is saved, the ticket stays in Planning
 *   - rejected: the reason is saved and the ticket is archived
 *
 * Entry point: `decideTicket()`. It never throws; on any failure nothing changes. All effects go
 * through `DecisionDeps` (the grooming deps plus the move to Done), so tests run it without Electron.
 */
import type { Task, TaskMetadata } from '../shared/types';
import {
  DECISION_SCHEMA,
  DECISION_SYSTEM_PROMPT,
  buildDecisionBlock,
  buildDecisionPrompt,
  buildDecisionTicketDescription,
  isAwaitingDecision,
  normalizeDecisionResult,
  type DecisionAction,
  type DecisionData,
  type DecisionOutcome,
} from '../shared/utils/decision-tickets';
import { isOpenForFollowUp } from '../shared/utils/follow-up-tickets';
import { appendNoteBlock } from '../shared/utils/queue-grooming';
import { defaultGroomingDeps, type GroomingDeps } from './queue-grooming';
import { inheritedMetadata } from './task-split';
import { appLog } from './app-logger';

export interface DecisionDeps extends GroomingDeps {
  /** Move a ticket that never ran to Done (no worktree, nothing to merge) */
  markDone(projectId: string, taskId: string): Promise<void>;
}

let cachedDefaults: DecisionDeps | null = null;

function defaultDeps(): DecisionDeps {
  if (cachedDefaults) return cachedDefaults;
  cachedDefaults = {
    ...defaultGroomingDeps(),
    async markDone(projectId, taskId) {
      const { invokeIpcHandler } = await import('./ipc-handlers/ipc-registry');
      const { IPC_CHANNELS } = await import('../shared/constants');
      const result = await invokeIpcHandler<{ success: boolean; error?: string }>(IPC_CHANNELS.TASK_UPDATE_STATUS, taskId, 'done', undefined, projectId);
      if (!result?.success) throw new Error(result?.error || 'Could not move the ticket to Done');
    },
  };
  return cachedDefaults;
}

export interface DecisionRequest {
  action: DecisionAction;
  /** The person's words (required for `tickets`) */
  text: string;
}

export interface DecisionResponse {
  success: boolean;
  error?: string;
  data?: DecisionData;
}

/** Tickets being decided, by `<project id>:<task id>`: a second press while the model runs does nothing */
const inFlight = new Set<string>();

/**
 * Apply the person's decision on a needs-decision ticket. Never throws. For `tickets` with no
 * ticket in the answer, nothing changes and `data.outcome` is 'none' (the record is returned so
 * the person can see why).
 */
export async function decideTicket(
  projectId: string,
  taskId: string,
  request: DecisionRequest,
  deps: DecisionDeps = defaultDeps()
): Promise<DecisionResponse> {
  const key = `${projectId}:${taskId}`;
  if (inFlight.has(key)) return { success: false, error: 'This decision is already being processed' };
  inFlight.add(key);
  try {
    return await run(projectId, taskId, request, deps);
  } catch (error) {
    appLog.warn(`[Decision] Could not apply the decision on ${taskId}:`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    inFlight.delete(key);
  }
}

function findDecisionTicket(deps: DecisionDeps, projectId: string, taskId: string): Task | undefined {
  const task = deps.getTasks(projectId).find((t) => t.id === taskId);
  if (!task || task.metadata?.archivedAt || task.status !== 'backlog' || !isAwaitingDecision(task.metadata)) return undefined;
  return task;
}

async function run(projectId: string, taskId: string, request: DecisionRequest, deps: DecisionDeps): Promise<DecisionResponse> {
  const project = deps.getProject(projectId);
  if (!project) return { success: false, error: 'Project not found' };
  const ticket = findDecisionTicket(deps, projectId, taskId);
  if (!ticket) return { success: false, error: 'This ticket is not waiting for a decision' };
  const decisionText = request.text.trim();
  const at = new Date().toISOString();

  if (request.action === 'defer' || request.action === 'reject') {
    const outcome: DecisionOutcome = request.action === 'defer' ? 'deferred' : 'rejected';
    await deps.updateTask(projectId, ticket.id, {
      description: appendNoteBlock(ticket.description, buildDecisionBlock(outcome, decisionText)),
      metadata: { decision: { text: decisionText, at, outcome } },
    });
    if (outcome === 'rejected') deps.archive(projectId, [ticket.id]);
    deps.changed(projectId);
    return { success: true, data: { outcome, created: [], decisionRecord: '' } };
  }

  if (!decisionText) return { success: false, error: 'Write what should happen first' };

  const from = ticket.metadata?.followUpFrom;
  const source = from ? deps.getTasks(projectId).find((t) => t.id === from.taskId) : undefined;
  const open = deps.getTasks(projectId).filter((t) => t.id !== ticket.id && !t.metadata?.archivedAt && isOpenForFollowUp(t.status));

  // Any failure here leaves everything as it was
  const raw = await deps.runModel({
    prompt: buildDecisionPrompt({
      ticket: { id: ticket.id, title: ticket.title, description: ticket.description },
      source: source
        ? {
            id: source.id,
            title: source.title,
            headline: source.claudeRun?.reviewSummary?.headline,
            whatChanged: source.claudeRun?.reviewSummary?.whatChanged,
            summary: source.claudeRun?.summary,
          }
        : undefined,
      openTickets: open.map((t) => ({ id: t.id, title: t.title, status: t.status, description: t.description })),
      decision: decisionText,
    }),
    systemPrompt: DECISION_SYSTEM_PROMPT,
    jsonSchema: DECISION_SCHEMA,
    cwd: project.path,
    profileId: project.settings?.claudeProfileId,
  });
  if (raw === null || raw === undefined) return { success: false, error: 'The model gave no usable answer' };
  const result = normalizeDecisionResult(raw);
  if (result.tickets.length === 0) {
    return { success: true, data: { outcome: 'none', created: [], decisionRecord: result.decisionRecord } };
  }

  // The model took a while: the ticket may have been decided, moved or deleted
  const fresh = findDecisionTicket(deps, projectId, taskId);
  if (!fresh) return { success: false, error: 'This ticket changed while the model was working. Nothing was created' };

  const created: DecisionData['created'] = [];
  const queued: string[] = [];
  let firstError: unknown;
  for (const plan of result.tickets) {
    try {
      const metadata: TaskMetadata = {
        ...inheritedMetadata(fresh.metadata),
        sourceType: 'manual',
        dependsOnTaskIds: [...(fresh.metadata?.dependsOnTaskIds ?? [])],
        // No needsDecision: these are plain tickets
        followUpFrom: { taskId: fresh.id, item: 'decision' },
      };
      const id = await deps.createTask(projectId, plan.title, buildDecisionTicketDescription(plan, fresh.id), metadata);
      if (!id) continue;
      created.push({ taskId: id, queued: plan.queue });
      if (plan.queue) queued.push(id);
    } catch (error) {
      firstError ??= error;
      appLog.warn(`[Decision] Could not create a ticket for "${plan.title}":`, error);
    }
  }
  if (created.length === 0) {
    return { success: false, error: firstError instanceof Error ? firstError.message : 'Could not create the tickets' };
  }
  try {
    if (queued.length > 0) await deps.queueTasks?.(projectId, queued, 'end');
  } catch (error) {
    appLog.warn('[Decision] Could not queue the new tickets:', error);
  }

  await deps.updateTask(projectId, fresh.id, {
    description: appendNoteBlock(fresh.description, buildDecisionBlock('tickets', decisionText, result.decisionRecord)),
    metadata: { decision: { text: decisionText, at, outcome: 'tickets', ticketIds: created.map((c) => c.taskId) } },
  });
  try {
    await deps.markDone(projectId, fresh.id);
  } catch (error) {
    appLog.warn(`[Decision] Could not move ${fresh.id} to Done:`, error);
  }
  deps.changed(projectId);
  appLog.info(`[Decision] ${fresh.id}: ${created.length} ticket(s) created`);
  return { success: true, data: { outcome: 'tickets', created, decisionRecord: result.decisionRecord } };
}
