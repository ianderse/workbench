/**
 * Spec batches and the Spec review loop
 * =====================================
 *
 * Tickets made by "Break into tasks" belong to a batch (`metadata.specBatch`), kept per project in
 * `.workbench/spec-batches.json` (the same way `queue-proposals.json` is stored). When every ticket
 * of a batch is finished (Human Review as completed / auto-merged, Done or archived), a Spec review
 * ticket is created and queued. When that review has run, its report is applied: gap tickets for
 * the next round (up to `maxReviewRounds`), or the batch is complete, or it stays open with its gaps.
 *
 * Entry points: `registerSpecBatch()`, `evaluateSpecBatch()` (the trigger, idempotent),
 * `applySpecReview()` and `evaluateAllSpecBatches()` (startup). Nothing here throws into the task
 * flow; each project's operations run one after the other. All effects on tickets go through
 * `SpecBatchDeps`, so tests run the whole flow without Electron.
 */
import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Project, Task, TaskMetadata } from '../shared/types';
import type { SpecBatch, SpecBatchesFile, SpecBatchRound } from '../shared/types/spec-review';
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  batchReadiness,
  buildReviewDescription,
  extractSpecPaths,
  normalizeSpecReview,
  planReviewOutcome,
  promptExcerpt,
  reviewTicketTitle,
  specTextCopy,
} from '../shared/utils/spec-review';
import { openFollowUpIdsOf } from '../shared/utils/dependents-wait';
import { isOpenTicket } from '../shared/utils/open-tickets';
import { writeFileAtomicSync } from './utils/atomic-file';
import { appLog } from './app-logger';
import { projectStore } from './project-store';

export const SPEC_BATCHES_FILE = 'spec-batches.json';
const MAX_BATCHES = 100;

// =============================================================================
// Dependencies (replaced in tests)
// =============================================================================

export interface SpecBatchDeps {
  getProject(projectId: string): Project | undefined;
  /** Fresh tasks of a project */
  getTasks(projectId: string): Task[];
  /** Create a card in Planning; resolves to its id */
  createTask(projectId: string, title: string, description: string, metadata: TaskMetadata): Promise<string | null>;
  /** Move cards to the top of the Queue, in the given order */
  queueTasks(projectId: string, taskIds: string[]): Promise<void>;
  /** Tasks changed: refresh the board and the queue */
  changed(projectId: string): void;
  now?(): Date;
}

let configuredNotify: ((projectId: string) => void) | null = null;

/** Called once at startup with the function that tells the board to reload */
export function configureSpecBatches(notify: (projectId: string) => void): void {
  configuredNotify = notify;
}

let cachedDefaults: SpecBatchDeps | null = null;

function defaultDeps(): SpecBatchDeps {
  if (cachedDefaults) return cachedDefaults;
  cachedDefaults = {
    getProject: (id) => projectStore.getProject(id),
    // Re-read from disk: the state change that triggered this was written a moment ago
    getTasks: (id) => {
      projectStore.invalidateTasksCache(id);
      return projectStore.getTasks(id);
    },
    async createTask(projectId, title, description, metadata) {
      const { invokeIpcHandler } = await import('./ipc-handlers/ipc-registry');
      const { IPC_CHANNELS } = await import('../shared/constants');
      const result = await invokeIpcHandler<{ success: boolean; error?: string; data?: Task }>(
        IPC_CHANNELS.TASK_CREATE,
        projectId,
        title,
        description,
        metadata
      );
      if (!result?.success) throw new Error(result?.error || 'Could not create the task');
      return result.data?.id ?? null;
    },
    async queueTasks(projectId, ids) {
      const { invokeIpcHandler } = await import('./ipc-handlers/ipc-registry');
      const { IPC_CHANNELS } = await import('../shared/constants');
      // The newest unplaced card sits at the top of the Queue, so the first one moves last
      for (const id of [...ids].reverse()) {
        const moved = await invokeIpcHandler<{ success: boolean; error?: string }>(IPC_CHANNELS.TASK_UPDATE_STATUS, id, 'queue', undefined, projectId);
        if (!moved?.success) appLog.warn(`[SpecReview] Could not queue ${id}:`, moved?.error);
      }
      const { taskQueueOrder } = await import('./services/task-queue-order');
      taskQueueOrder.set(projectId, [...ids, ...taskQueueOrder.get(projectId).filter((id) => !ids.includes(id))]);
    },
    changed: (projectId) => configuredNotify?.(projectId),
  };
  return cachedDefaults;
}

// =============================================================================
// Batches file
// =============================================================================

export function getSpecBatchesPath(project: Pick<Project, 'path' | 'autoBuildPath'>): string {
  return path.join(project.path, project.autoBuildPath || '.workbench', SPEC_BATCHES_FILE);
}

export async function readSpecBatches(project: Pick<Project, 'path' | 'autoBuildPath'>): Promise<SpecBatchesFile> {
  const file = getSpecBatchesPath(project);
  if (!existsSync(file)) return { version: 1, batches: [] };
  try {
    const data = JSON.parse(await readFile(file, 'utf-8')) as Partial<SpecBatchesFile>;
    return { version: 1, batches: Array.isArray(data.batches) ? data.batches : [] };
  } catch {
    return { version: 1, batches: [] };
  }
}

async function writeSpecBatches(project: Pick<Project, 'path' | 'autoBuildPath'>, data: SpecBatchesFile): Promise<void> {
  const file = getSpecBatchesPath(project);
  await mkdir(path.dirname(file), { recursive: true });
  writeFileAtomicSync(file, JSON.stringify({ version: 1, batches: data.batches.slice(-MAX_BATCHES) }, null, 2));
}

/** Operations on one project's batches run one after the other */
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(projectId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(projectId, tail);
  void tail.then(() => {
    if (chains.get(projectId) === tail) chains.delete(projectId);
  });
  return run;
}

function findTask(tasks: readonly Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id || t.specId === id);
}

// =============================================================================
// Registering a batch
// =============================================================================

export interface RegisterSpecBatchInput {
  id: string;
  /** The prompt the tickets were made from */
  prompt: string;
  /** Spec files the prompt referenced (defaults to the `docs/...md`-style paths in the prompt) */
  sources?: string[];
  taskIds: string[];
  maxReviewRounds?: number;
}

/** Spec files a prompt points at, for the ticket metadata and the batch record */
export function specSourcesOf(prompt: string): string[] {
  return extractSpecPaths(prompt);
}

/** Record a batch (or add tickets to it); the ticket ids are the ones Break into tasks created */
export function registerSpecBatch(projectId: string, input: RegisterSpecBatchInput, deps: SpecBatchDeps = defaultDeps()): Promise<SpecBatch | null> {
  return serialized(projectId, async () => {
    const project = deps.getProject(projectId);
    if (!project) return null;
    const file = await readSpecBatches(project);
    const sources = input.sources ?? extractSpecPaths(input.prompt);
    let batch = file.batches.find((b) => b.id === input.id);
    if (!batch) {
      batch = {
        id: input.id,
        source: sources,
        promptExcerpt: promptExcerpt(input.prompt),
        ...(sources.length === 0 ? { specText: specTextCopy(input.prompt) } : {}),
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
        taskIds: [],
        reviewRounds: 0,
        maxReviewRounds: input.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS,
        round: 0,
        status: 'building',
        rounds: [],
      };
      file.batches.push(batch);
    }
    for (const id of input.taskIds) if (!batch.taskIds.includes(id)) batch.taskIds.push(id);
    await writeSpecBatches(project, file);
    return batch;
  });
}

/** The record of a batch; one derived from its tickets when the app never saw the registration */
function ensureBatch(file: SpecBatchesFile, batchId: string, tasks: readonly Task[], deps: SpecBatchDeps): SpecBatch | undefined {
  const existing = file.batches.find((b) => b.id === batchId);
  if (existing) return existing;
  const members = tasks.filter((t) => t.metadata?.specBatch?.id === batchId);
  if (members.length === 0) return undefined;
  const batch: SpecBatch = {
    id: batchId,
    source: members[0].metadata?.specBatch?.source ?? [],
    promptExcerpt: members[0].title,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    taskIds: members.map((t) => t.id),
    reviewRounds: 0,
    maxReviewRounds: DEFAULT_MAX_REVIEW_ROUNDS,
    round: Math.max(...members.map((t) => t.metadata?.specBatch?.round ?? 0)),
    status: 'building',
    rounds: [],
  };
  file.batches.push(batch);
  return batch;
}

function reviewTaskOf(tasks: readonly Task[], batchId: string, round: number): Task | undefined {
  return tasks.find((t) => t.metadata?.specReview?.batchId === batchId && t.metadata.specReview.round === round);
}

// =============================================================================
// Trigger
// =============================================================================

/**
 * Create the batch's Spec review ticket when all its tickets are finished. Safe to call at any
 * time and any number of times: at most one review ticket exists per batch round.
 */
export function evaluateSpecBatch(projectId: string, batchId: string, deps: SpecBatchDeps = defaultDeps()): Promise<void> {
  return serialized(projectId, () => evaluateLocked(projectId, batchId, deps)).catch((error) => {
    appLog.warn(`[SpecReview] Could not evaluate batch ${batchId}:`, error);
  });
}

async function evaluateLocked(projectId: string, batchId: string, deps: SpecBatchDeps): Promise<void> {
  const project = deps.getProject(projectId);
  if (!project || project.settings?.specReview === false) return;
  const tasks = deps.getTasks(projectId);
  const file = await readSpecBatches(project);
  const batch = ensureBatch(file, batchId, tasks, deps);
  if (!batch) return;

  if (batch.status === 'reviewing') {
    // The review ticket was deleted: build the round again
    if (reviewTaskOf(tasks, batch.id, batch.round)) return;
    batch.rounds = batch.rounds.filter((r) => r.round !== batch.round);
    batch.status = 'building';
  }
  if (batch.status !== 'building') return;
  if (batchReadiness(batch, tasks) !== 'ready') return;

  // A review ticket for this round made before the record was saved is adopted, not repeated
  let reviewId = reviewTaskOf(tasks, batch.id, batch.round)?.id;
  if (!reviewId) {
    const members = batch.taskIds.map((id) => findTask(tasks, id)).filter((t): t is Task => !!t);
    const baseBranch = members.map((t) => t.metadata?.baseBranch).find((b): b is string => !!b);
    const metadata: TaskMetadata = {
      sourceType: 'manual',
      specReview: { batchId: batch.id, round: batch.round, maxRounds: batch.maxReviewRounds },
      // Follow-ups of the batch's tickets are part of its scope, so the review waits for them too
      dependsOnTaskIds: [...new Set([...members.map((t) => t.id), ...openFollowUpIdsOf(tasks, members.map((t) => t.id))])],
      // The review reads what was merged, including merges that were not pushed
      useLocalBranch: true,
      ...(baseBranch ? { baseBranch } : {}),
    };
    reviewId = (await deps.createTask(
      projectId,
      reviewTicketTitle(batch, batch.round),
      buildReviewDescription(batch, members.map((t) => ({ id: t.id, title: t.title })), batch.round),
      metadata
    )) ?? undefined;
    if (!reviewId) return;
    await deps.queueTasks(projectId, [reviewId]);
    appLog.info(`[SpecReview] Created the spec review ticket ${reviewId} for batch ${batch.id} (round ${batch.round})`);
  }
  batch.rounds = [...batch.rounds.filter((r) => r.round !== batch.round), { round: batch.round, reviewTaskId: reviewId, gapTaskIds: [] }];
  batch.status = 'reviewing';
  await writeSpecBatches(project, file);
  deps.changed(projectId);
}

// =============================================================================
// After the review
// =============================================================================

/**
 * Apply a finished Spec review ticket (Human Review, completed): create the gap tickets of the next
 * round, or close the batch. Runs once per review; a second call finds it applied.
 */
export function applySpecReview(projectId: string, reviewTaskId: string, deps: SpecBatchDeps = defaultDeps()): Promise<void> {
  return serialized(projectId, () => applyLocked(projectId, reviewTaskId, deps)).catch((error) => {
    appLog.warn(`[SpecReview] Could not apply the review ${reviewTaskId}:`, error);
  });
}

async function applyLocked(projectId: string, reviewTaskId: string, deps: SpecBatchDeps): Promise<void> {
  const project = deps.getProject(projectId);
  if (!project) return;
  const tasks = deps.getTasks(projectId);
  const review = findTask(tasks, reviewTaskId);
  const ref = review?.metadata?.specReview;
  if (!review || !ref || review.status !== 'human_review' || review.reviewReason !== 'completed') return;

  const file = await readSpecBatches(project);
  const batch = ensureBatch(file, ref.batchId, tasks, deps);
  if (!batch) return;
  let entry: SpecBatchRound | undefined = batch.rounds.find((r) => r.round === ref.round);
  // An unverified review is applied again when the same ticket is rerun and reports once more
  if (entry?.processedAt && batch.status !== 'unverified') return;
  const firstApply = !entry?.processedAt;
  if (!entry) {
    entry = { round: ref.round, reviewTaskId: review.id, gapTaskIds: [] };
    batch.rounds.push(entry);
  }

  const openIds = new Set(tasks.filter(isOpenTicket).map((t) => t.id));
  const report = normalizeSpecReview(review.claudeRun?.specReview, openIds);
  if (!report) {
    appLog.warn(`[SpecReview] The review ${review.id} has no report yet`);
    return;
  }
  const outcome = planReviewOutcome(report, ref.round, batch.maxReviewRounds);

  if (outcome.kind === 'create_gaps') {
    const gapKeys = (entry.gapKeys ??= {});
    const baseBranch = review.metadata?.baseBranch;
    for (const gap of report.gaps) {
      if (gapKeys[gap.key]) continue;
      const waitsFor = gap.dependsOn.map((d) => gapKeys[d] ?? (openIds.has(d) ? d : undefined)).filter((d): d is string => !!d);
      const where = batch.source.length > 0 ? `\n\nSpec: ${batch.source.join(', ')}` : '';
      const id = await deps.createTask(
        projectId,
        gap.title,
        `${gap.description}\n\nSpec section: ${gap.specSection}\nEvidence: ${gap.evidence}${where}`,
        {
          sourceType: 'manual',
          specBatch: { id: batch.id, source: batch.source, round: outcome.nextRound },
          ...(waitsFor.length > 0 ? { dependsOnTaskIds: waitsFor } : {}),
          ...(baseBranch ? { baseBranch } : {}),
        }
      );
      if (!id) throw new Error('Could not create a gap ticket');
      gapKeys[gap.key] = id;
      entry.gapTaskIds.push(id);
      // Saved as it goes, so a failure later does not create this ticket again
      await writeSpecBatches(project, file);
    }
    await deps.queueTasks(projectId, entry.gapTaskIds);
    for (const id of entry.gapTaskIds) if (!batch.taskIds.includes(id)) batch.taskIds.push(id);
    batch.round = outcome.nextRound;
  }
  batch.status = outcome.status;
  if (firstApply) batch.reviewRounds += 1;
  entry.processedAt = (deps.now?.() ?? new Date()).toISOString();
  await writeSpecBatches(project, file);
  deps.changed(projectId);
  appLog.info(`[SpecReview] Batch ${batch.id}: review of round ${ref.round} applied (${outcome.kind}, ${report.gaps.length} gaps)`);
}

/** How many gap tickets the review created (for the review card's headline) */
export function gapTicketsCreated(batch: SpecBatch | undefined, round: number): number {
  return batch?.rounds.find((r) => r.round === round)?.gapTaskIds.length ?? 0;
}

// =============================================================================
// Startup
// =============================================================================

/** Catch up on batches whose state changed while the app was closed */
export async function evaluateAllSpecBatches(deps: SpecBatchDeps = defaultDeps(), projectIds?: string[]): Promise<void> {
  for (const projectId of projectIds ?? projectStore.getProjects().map((p) => p.id)) {
    const project = deps.getProject(projectId);
    if (!project) continue;
    const file = await readSpecBatches(project);
    const tasks = deps.getTasks(projectId);
    for (const batch of file.batches) {
      if (batch.status === 'building' || batch.status === 'reviewing') await evaluateSpecBatch(projectId, batch.id, deps);
      for (const round of batch.rounds) {
        if (!round.processedAt) await applySpecReview(projectId, round.reviewTaskId, deps);
      }
    }
    // Batches never saved (the app closed right after Break into tasks)
    const known = new Set(file.batches.map((b) => b.id));
    for (const id of new Set(tasks.map((t) => t.metadata?.specBatch?.id).filter((x): x is string => !!x))) {
      if (!known.has(id)) await evaluateSpecBatch(projectId, id, deps);
    }
  }
}

export function newSpecBatchId(): string {
  return randomUUID();
}
