/**
 * Follow-up tickets
 * =================
 *
 * When a task reaches Human Review (completed or auto-merged), the "needs your attention" items of
 * its review summary that describe work become new tickets. One background, read-only model call
 * judges each item (see shared/utils/follow-up-tickets.ts): nothing to do, already covered by an
 * open ticket (that ticket gets a note), clear in-scope work (a new ticket in the Queue) or work a
 * person has to decide on first (a new ticket in Planning, which never starts by itself).
 *
 * Trigger: the `state` task hook (ipc-handlers/queue-grooming-handlers.ts), not the panel. The
 * summary is written in the background right after the run ends, so this gets it from the run info
 * (joining the run's own generation, or writing it when the run has none); the panel reuses it.
 *
 * Entry point: `createFollowUpTickets()`. It never throws and never blocks. All effects go through
 * `FollowUpDeps` (the grooming deps plus the summary lookup), so tests run the flow without Electron.
 */
import { randomUUID } from 'crypto';
import path from 'path';
import type { Project, Task, TaskMetadata } from '../shared/types';
import type { ReviewSummary } from '../shared/types/claude-code';
import type { TaskContextNote } from '../shared/types/queue-grooming';
import {
  FOLLOW_UP_SCHEMA,
  FOLLOW_UP_SYSTEM_PROMPT,
  buildCoveredNote,
  buildFollowUpDescription,
  buildFollowUpNoteBlock,
  buildFollowUpPrompt,
  isFollowUpTicketsEnabled,
  isOpenForFollowUp,
  normalizeFollowUpResult,
} from '../shared/utils/follow-up-tickets';
import { appendNoteBlock, isGroomableStatus } from '../shared/utils/queue-grooming';
import { defaultGroomingDeps, readQueueProposals, type GroomingDeps } from './queue-grooming';
import { inheritedMetadata } from './task-split';
import { appLog } from './app-logger';

/** Wait for the state machine and the run's own summary generation to start */
const SETTLE_MS = 3000;

export interface FollowUpDeps extends GroomingDeps {
  /** The review summary: the stored one, else the run's generation in flight, else a new one; null when none can be had */
  getReviewSummary(project: Project, task: Task): Promise<ReviewSummary | null>;
  /** Work this task already handed off to tickets that may not exist yet (a pending split proposal) */
  getAlreadySplitOff?(project: Project, task: Task): Promise<string[]>;
}

let cachedDefaults: FollowUpDeps | null = null;

function defaultDeps(): FollowUpDeps {
  if (cachedDefaults) return cachedDefaults;
  cachedDefaults = {
    ...defaultGroomingDeps(),
    async getReviewSummary(project, task) {
      const stored = task.claudeRun?.reviewSummary;
      if (stored) return stored;
      const [{ getSpecsDir }, { loadClaudeRunInfo, saveClaudeRunInfo }, { generateReviewSummary, trackReviewSummary }] = await Promise.all([
        import('../shared/constants'),
        import('./claude-code/task-runner'),
        import('./claude-code/review-summary'),
      ]);
      const specDir = path.join(project.path, getSpecsDir(project.autoBuildPath), task.specId);
      const info = loadClaudeRunInfo(specDir);
      if (!info) return null;
      if (info.reviewSummary) return info.reviewSummary;
      const [{ resolveEffectiveAgent }, { getAgentBackendSettings }] = await Promise.all([
        import('../shared/utils/agent-override'),
        import('./agent-backend/settings'),
      ]);
      // Same key as the run's own generation, so a second call joins the first
      return trackReviewSummary(`${project.id}:${task.specId}`, async () => {
        const made = await generateReviewSummary({
          info,
          title: task.title,
          request: task.description,
          backend: resolveEffectiveAgent(task.metadata?.agentOverride, getAgentBackendSettings().kind).backend,
          projectPath: project.path,
          projectId: project.id,
          taskId: task.specId,
        });
        if (!made) return null;
        const latest = loadClaudeRunInfo(specDir) ?? info;
        latest.reviewSummary = made;
        latest.updatedAt = new Date().toISOString();
        saveClaudeRunInfo(specDir, latest);
        return made;
      });
    },
    async getAlreadySplitOff(project, task) {
      const file = await readQueueProposals(project);
      return file.proposals.flatMap((p) => (p.kind === 'split' && p.taskId === task.id ? p.pieces.map((piece) => piece.title) : []));
    },
  };
  return cachedDefaults;
}

/** Tasks being handled, by `<project id>:<task id>`: the hook fires on every state event */
const inFlight = new Set<string>();

/** Runs for one project's tickets go one after the other */
const chains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

/** Whether a task's review is ready for follow-ups: Human Review as completed or auto-merged */
export function isFollowUpReviewState(task: Pick<Task, 'status' | 'reviewReason'>): boolean {
  return task.status === 'human_review' && (task.reviewReason === 'completed' || task.reviewReason === 'auto_merged');
}

export interface FollowUpOutcome {
  created: Array<{ taskId: string; action: 'queue' | 'planning' }>;
  coveredCount: number;
}

/**
 * Create the follow-up tickets of a task that reached Human Review. Handles each task once
 * (`metadata.followUpsCreatedAt`), skips Spec review tickets, and only runs when the project
 * setting `followUpTickets` is not off. Resolves to what it did, or null when it did nothing.
 * Never throws.
 */
export async function createFollowUpTickets(
  projectId: string,
  taskId: string,
  deps: FollowUpDeps = defaultDeps()
): Promise<FollowUpOutcome | null> {
  const key = `${projectId}:${taskId}`;
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    return await serialized(`followups:${projectId}`, () => run(projectId, taskId, deps));
  } catch (error) {
    appLog.warn(`[FollowUps] Could not create follow-up tickets for ${taskId}:`, error);
    return null;
  } finally {
    inFlight.delete(key);
  }
}

async function run(projectId: string, taskId: string, deps: FollowUpDeps): Promise<FollowUpOutcome | null> {
  const project = deps.getProject(projectId);
  if (!project || !isFollowUpTicketsEnabled(project.settings)) return null;
  const settle = deps.settleMs ?? SETTLE_MS;
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));

  const source = deps.getTasks(projectId).find((t) => t.id === taskId);
  if (
    !source ||
    !isFollowUpReviewState(source) ||
    source.metadata?.specReview ||
    source.metadata?.followUpsCreatedAt ||
    source.metadata?.archivedAt
  ) {
    return null;
  }

  const summary = await deps.getReviewSummary(project, source);
  if (!summary) return null;

  // Handled once, whatever the model says: recorded before the model call so a restart or a second
  // entry to Human Review does not repeat it
  const items = summary.needsAttention.map((item) => item.trim()).filter(Boolean);
  await deps.updateTask(projectId, source.id, { metadata: { followUpsCreatedAt: new Date().toISOString() } });
  if (items.length === 0) return { created: [], coveredCount: 0 };

  const open = deps.getTasks(projectId).filter((t) => t.id !== source.id && !t.metadata?.archivedAt && isOpenForFollowUp(t.status));
  const alreadySplitOff = (await deps.getAlreadySplitOff?.(project, source)) ?? [];

  const raw = await deps.runModel({
    prompt: buildFollowUpPrompt({
      source: {
        id: source.id,
        title: source.title,
        description: source.description,
        summary: source.claudeRun?.summary,
        headline: summary.headline,
        whatChanged: summary.whatChanged,
      },
      needsAttention: items,
      openTickets: open.map((t) => ({ id: t.id, title: t.title, status: t.status, description: t.description })),
      alreadySplitOff,
    }),
    systemPrompt: FOLLOW_UP_SYSTEM_PROMPT,
    jsonSchema: FOLLOW_UP_SCHEMA,
    cwd: project.path,
    profileId: project.settings?.claudeProfileId,
  });

  // The model took a while: tickets may have moved
  const freshOpen = deps.getTasks(projectId).filter((t) => t.id !== source.id && !t.metadata?.archivedAt && isOpenForFollowUp(t.status));
  const result = normalizeFollowUpResult(raw, {
    openTicketIds: new Set(freshOpen.map((t) => t.id)),
    noteableTicketIds: new Set(freshOpen.filter((t) => isGroomableStatus(t.status)).map((t) => t.id)),
    sourceIsFollowUp: !!source.metadata?.followUpFrom,
  });
  if (result.tickets.length === 0 && result.covered.length === 0) return { created: [], coveredCount: 0 };

  const created: FollowUpOutcome['created'] = [];
  const queued: string[] = [];
  for (const plan of result.tickets) {
    try {
      const metadata: TaskMetadata = {
        ...inheritedMetadata(source.metadata),
        sourceType: 'manual',
        // The queue waits for the merge of the reviewed task (autonomous mode counts an auto-merge as done)
        dependsOnTaskIds: [source.id],
        followUpFrom: { taskId: source.id, item: plan.item, ...(plan.action === 'planning' ? { needsDecision: true } : {}) },
      };
      const id = await deps.createTask(projectId, plan.title, buildFollowUpDescription(plan, source.id), metadata);
      if (!id) continue;
      created.push({ taskId: id, action: plan.action });
      if (plan.action === 'queue') queued.push(id);
    } catch (error) {
      appLog.warn(`[FollowUps] Could not create a ticket for "${plan.title}":`, error);
    }
  }
  try {
    if (queued.length > 0) await deps.queueTasks?.(projectId, queued, 'end');
  } catch (error) {
    appLog.warn('[FollowUps] Could not queue the follow-up tickets:', error);
  }

  for (const plan of result.covered) {
    try {
      const target = deps.getTasks(projectId).find((t) => t.id === plan.coveredBy);
      if (!target || !isGroomableStatus(target.status)) continue;
      await addFollowUpNote(deps, projectId, target, source.id, buildCoveredNote(plan));
    } catch (error) {
      appLog.warn(`[FollowUps] Could not add a note to ${plan.coveredBy}:`, error);
    }
  }

  if (created.length > 0) await deps.updateTask(projectId, source.id, { metadata: { followUpTickets: created } });
  deps.changed(projectId);
  appLog.info(`[FollowUps] ${source.id}: ${created.length} ticket(s) created, ${result.covered.length} covered`);
  return { created, coveredCount: result.covered.length };
}

async function addFollowUpNote(deps: FollowUpDeps, projectId: string, task: Task, fromTaskId: string, note: string): Promise<void> {
  const existing = task.metadata?.contextNotes ?? [];
  if (existing.some((n) => n.fromTaskId === fromTaskId && n.note === note)) return;
  const block = buildFollowUpNoteBlock(fromTaskId, note);
  const entry: TaskContextNote = { id: randomUUID(), fromTaskId, note, block, at: new Date().toISOString(), kind: 'followUp' };
  await deps.updateTask(projectId, task.id, {
    description: appendNoteBlock(task.description, block),
    metadata: { contextNotes: [...existing, entry] },
  });
}
