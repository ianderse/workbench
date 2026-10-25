/**
 * Queue grooming
 * ==============
 *
 * Tickets are written before the code exists, so the tickets still waiting in Planning and the
 * Queue go stale as earlier tasks merge. After a merge, one background, read-only model call
 * compares the merged task with those tickets and answers with
 *   - notes: short context to add to a ticket (applied right away, stored in
 *     `metadata.contextNotes` so they can be shown and undone),
 *   - obsolete / duplicate tickets and new tasks: structural changes, kept as proposals in
 *     `.workbench/queue-proposals.json` until the user applies or dismisses them. With
 *     `autoApplyStructural` (a future autonomous mode) they are applied at once, each with an undo entry.
 *
 * Entry point: `groomQueueAfterMerge()`. It never throws and never blocks the merge flow.
 * The model answer is validated by `normalizeGroomingResult()` (shared/utils/queue-grooming.ts).
 * All effects on tasks go through `GroomingDeps`, so tests can run the whole flow without Electron.
 */
import { existsSync } from 'fs';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Project, Task, TaskMetadata } from '../shared/types';
import type {
  SplitProposal,
  QueueProposal,
  QueueProposalsFile,
  QueueUndoEntry,
  TaskContextNote,
} from '../shared/types/queue-grooming';
import {
  appendNoteBlock,
  buildNoteBlock,
  isGroomableStatus,
  normalizeGroomingResult,
  planArchive,
  removeNoteBlock,
  type GroomTask,
} from '../shared/utils/queue-grooming';
import { writeFileAtomicSync } from './utils/atomic-file';
import { appLog } from './app-logger';
import { readTaskChangelog, getTaskChangelogPath, foldTaskChangelog } from './task-changelog';
import { mergedFromChangelog } from './task-briefing';
import { projectStore } from './project-store';
import { applyTaskSplit, undoTaskSplit } from './task-split';
import type { NormalizedSplit } from '../shared/utils/task-split';

export const QUEUE_PROPOSALS_FILE = 'queue-proposals.json';
const MAX_UNDO_ENTRIES = 50;
const MAX_PROPOSALS = 40;
/** Wait for the merge flow to finish writing the task's files before reading them */
const SETTLE_MS = 2000;
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_PLAN_CHARS = 4000;
const MAX_SUMMARY_CHARS = 3000;
const MAX_REVIEW_CHARS = 3000;
const MAX_FILES_SHOWN = 40;

// =============================================================================
// Dependencies (replaced in tests)
// =============================================================================

export interface GroomingModelInput {
  prompt: string;
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  cwd: string;
  profileId?: string;
}

export interface GroomingDeps {
  getProject(projectId: string): Project | undefined;
  getTasks(projectId: string): Task[];
  /** The model's structured answer */
  runModel(input: GroomingModelInput): Promise<unknown>;
  /** Edit a task like the task dialog does (title, description, metadata fields) */
  updateTask(projectId: string, taskId: string, updates: { description?: string; metadata?: Partial<TaskMetadata> }): Promise<void>;
  /** Create a card in Planning; resolves to its id */
  createTask(projectId: string, title: string, description: string, metadata: TaskMetadata): Promise<string | null>;
  /** Move freshly created cards to the top of the Queue, in the given order */
  queueTasks?(projectId: string, taskIds: string[]): Promise<void>;
  archive(projectId: string, taskIds: string[]): void;
  unarchive(projectId: string, taskIds: string[]): void;
  /** Tasks or proposals changed: refresh the board */
  changed(projectId: string): void;
  settleMs?: number;
}

let configuredNotify: ((projectId: string) => void) | null = null;

/** Called once at startup with the function that tells the board to reload */
export function configureQueueGrooming(notify: (projectId: string) => void): void {
  configuredNotify = notify;
}

let cachedDefaults: GroomingDeps | null = null;

function defaultDeps(): GroomingDeps {
  if (cachedDefaults) return cachedDefaults;
  cachedDefaults = {
    getProject: (id) => projectStore.getProject(id),
    // Re-read from disk: the merge that triggered this changed task files a moment ago
    getTasks: (id) => {
      projectStore.invalidateTasksCache(id);
      return projectStore.getTasks(id);
    },
    async runModel(input) {
      const { runClaudeText, READ_ONLY_TOOLS } = await import('./claude-code/run-text');
      const { resolveClaudeCodeTaskSettings } = await import('./claude-code/settings');
      const { readSettingsFile } = await import('./settings-utils');
      const settings = (readSettingsFile() ?? {}) as { claudeCodeTasks?: unknown };
      const { triageModel } = resolveClaudeCodeTaskSettings(settings.claudeCodeTasks as never);
      const result = await runClaudeText({
        prompt: input.prompt,
        appendSystemPrompt: input.systemPrompt,
        model: triageModel,
        ompRole: 'plan',
        effort: 'medium',
        jsonSchema: input.jsonSchema,
        cwd: input.cwd,
        tools: READ_ONLY_TOOLS,
        maxTurns: 30,
        profileId: input.profileId,
        // Local models are slow; OMP multiplies this
        timeoutMs: 10 * 60 * 1000,
      });
      if (result.structured !== undefined) return result.structured;
      try {
        return JSON.parse(result.text);
      } catch {
        return null;
      }
    },
    async updateTask(projectId, taskId, updates) {
      const { invokeIpcHandler } = await import('./ipc-handlers/ipc-registry');
      const { IPC_CHANNELS } = await import('../shared/constants');
      const result = await invokeIpcHandler<{ success: boolean; error?: string }>(IPC_CHANNELS.TASK_UPDATE, taskId, updates, projectId);
      if (!result?.success) throw new Error(result?.error || 'Could not update the task');
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
      // The newest unplaced card sits at the top of the Queue, so the first piece moves last
      for (const id of [...ids].reverse()) {
        const moved = await invokeIpcHandler<{ success: boolean; error?: string }>(IPC_CHANNELS.TASK_UPDATE_STATUS, id, 'queue', undefined, projectId);
        if (!moved?.success) appLog.warn(`[QueueGrooming] Could not queue ${id}:`, moved?.error);
      }
      // The main-process queue starts the top task first
      const { taskQueueOrder } = await import('./services/task-queue-order');
      taskQueueOrder.set(projectId, [...ids, ...taskQueueOrder.get(projectId).filter((id) => !ids.includes(id))]);
    },
    archive: (projectId, ids) => {
      projectStore.archiveTasks(projectId, ids);
    },
    unarchive: (projectId, ids) => {
      projectStore.unarchiveTasks(projectId, ids);
    },
    changed: (projectId) => {
      configuredNotify?.(projectId);
    },
  };
  return cachedDefaults;
}

// =============================================================================
// Proposals file
// =============================================================================

export function getQueueProposalsPath(project: Pick<Project, 'path' | 'autoBuildPath'>): string {
  return path.join(project.path, project.autoBuildPath || '.workbench', QUEUE_PROPOSALS_FILE);
}

function emptyFile(): QueueProposalsFile {
  return { version: 1, proposals: [], undo: [] };
}

export async function readQueueProposals(project: Pick<Project, 'path' | 'autoBuildPath'>): Promise<QueueProposalsFile> {
  const file = getQueueProposalsPath(project);
  if (!existsSync(file)) return emptyFile();
  try {
    const data = JSON.parse(await readFile(file, 'utf-8')) as Partial<QueueProposalsFile>;
    return {
      version: 1,
      proposals: Array.isArray(data.proposals) ? data.proposals : [],
      undo: Array.isArray(data.undo) ? data.undo : [],
    };
  } catch {
    return emptyFile();
  }
}

async function writeQueueProposals(project: Pick<Project, 'path' | 'autoBuildPath'>, data: QueueProposalsFile): Promise<void> {
  const file = getQueueProposalsPath(project);
  await mkdir(path.dirname(file), { recursive: true });
  writeFileAtomicSync(
    file,
    JSON.stringify({ ...data, proposals: data.proposals.slice(-MAX_PROPOSALS), undo: data.undo.slice(-MAX_UNDO_ENTRIES) }, null, 2)
  );
}

/** Operations with the same key run one after the other */
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  chains.set(key, next.catch(() => undefined));
  return next;
}

/**
 * Changes to a project's proposals and tickets run one after the other. The model call is not part
 * of it, so pressing Apply while a groom is thinking does not wait for the model.
 */
function withStateLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return serialized(`state:${projectId}`, fn);
}

// =============================================================================
// Prompt
// =============================================================================

const GROOMING_SYSTEM_PROMPT = `You keep a software project's task queue accurate. A task was just merged into the base branch. Other tickets (in Planning or the Queue) were written before that code existed, so some are now partly done, redundant, or missing context. You do NOT write code and you do NOT change files.

You can read the project (the checkout is the base branch with the merged work). Check claims against the code before you make them. Then answer with the structured output only.

Rules:
- "note": a short, concrete addition for a ticket that the merge affects, e.g. "Task 1 implemented the PRNG in src/core/prng.ts; use createRng(seed)". Name real files, functions and decisions. 1-3 sentences. Only when it saves the ticket's agent from guessing or duplicating work. Do not restate the ticket.
- "obsolete": the ticket's whole outcome already exists after the merge, or can no longer apply. Give the evidence in "reason". When only part is done, use a note instead.
- "duplicate": two tickets ask for the same outcome. taskId is the one to archive, duplicateOf the one to keep. Never mark a ticket a duplicate of a ticket that is also archived.
- newTasks: follow-up work the merge left open (open review findings, deferred items) that no existing ticket covers. dependsOn lists ids of existing tasks the new card must wait for (usually none or the merged task is already done, so leave it out). Write a standalone description with acceptance criteria. Titles are short, in sentence case, with no trailing period.
- Be conservative: no update is better than a wrong one. At most one update per ticket. Use only task ids from the lists below. Never mention tasks that are not listed.`;

const GROOMING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', description: 'Id of a ticket in Planning or the Queue' },
          kind: { type: 'string', enum: ['note', 'obsolete', 'duplicate'] },
          note: { type: 'string', description: 'kind note: the context to add to the ticket' },
          duplicateOf: { type: 'string', description: 'kind duplicate: id of the ticket that stays' },
          reason: { type: 'string', description: 'Why, with evidence' },
        },
        required: ['taskId', 'kind', 'reason'],
      },
    },
    newTasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of existing tasks to wait for' },
          reason: { type: 'string' },
        },
        required: ['title', 'description', 'dependsOn', 'reason'],
      },
    },
  },
  required: ['updates', 'newTasks'],
};

function clip(text: string | undefined, max: number): string {
  const value = (text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`;
}

/** The final review report of a task, with the findings that are still open (minor ones included) */
export function renderReviewReport(run: Task['claudeRun'] | undefined): string {
  if (!run) return '';
  const lines: string[] = [];
  const report = run.validation;
  if (report) {
    lines.push(`Validation ${report.status}: ${report.summary}`);
    for (const check of report.checks.filter((c) => !c.passed)) lines.push(`- failing check: ${check.name}`);
    for (const finding of report.findings) {
      const where = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : '';
      lines.push(`- ${finding.fixed ? 'fixed' : 'OPEN'} ${finding.severity}: ${finding.description}${where}`);
    }
  }
  if (run.reviewVerdict) {
    lines.push(`AI review loop: ${run.reviewVerdict.status} after ${run.reviewVerdict.rounds} round(s)`);
    for (const finding of run.reviewVerdict.failure?.openFindings ?? []) {
      lines.push(`- OPEN ${finding.severity}: ${finding.description}${finding.file ? ` (${finding.file})` : ''}`);
    }
  }
  return lines.join('\n');
}

export function buildGroomingPrompt(merged: Task, files: readonly string[], candidates: readonly Task[]): string {
  const shownFiles = files.slice(0, MAX_FILES_SHOWN);
  const moreFiles = files.length > shownFiles.length ? `, and ${files.length - shownFiles.length} more` : '';
  const mergedBlock = [
    `<merged_task id="${merged.id}" title="${merged.title.replace(/"/g, "'")}">`,
    `Description:\n${clip(merged.description, MAX_DESCRIPTION_CHARS)}`,
    merged.claudeRun?.plan ? `Plan:\n${clip(merged.claudeRun.plan, MAX_PLAN_CHARS)}` : '',
    merged.claudeRun?.summary ? `Run summary:\n${clip(merged.claudeRun.summary, MAX_SUMMARY_CHARS)}` : '',
    shownFiles.length ? `Files changed: ${shownFiles.join(', ')}${moreFiles}` : '',
    renderReviewReport(merged.claudeRun) ? `Final review report:\n${clip(renderReviewReport(merged.claudeRun), MAX_REVIEW_CHARS)}` : '',
    '</merged_task>',
  ]
    .filter(Boolean)
    .join('\n');
  const tickets = candidates
    .map((task) => {
      const deps = task.metadata?.dependsOnTaskIds?.length ? ` depends_on="${task.metadata.dependsOnTaskIds.join(',')}"` : '';
      return `<ticket id="${task.id}" column="${task.status === 'queue' ? 'Queue' : 'Planning'}"${deps} title="${task.title.replace(/"/g, "'")}">\n${clip(task.description, MAX_DESCRIPTION_CHARS)}\n</ticket>`;
    })
    .join('\n');
  return `${mergedBlock}\n\nTickets waiting in Planning or the Queue:\n${tickets}`;
}

// =============================================================================
// Grooming
// =============================================================================

function toGroomTask(task: Task): GroomTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    archived: !!task.metadata?.archivedAt,
    dependsOn: task.metadata?.dependsOnTaskIds ?? [],
  };
}

export interface GroomOptions {
  /** Apply obsolete / duplicate / new task proposals at once, each with an undo entry (default false) */
  autoApplyStructural: boolean;
}

/**
 * After a task was merged: update the tickets waiting in Planning and the Queue. Notes are applied
 * automatically; structural changes become proposals (or are applied when `autoApplyStructural`).
 * Failures are only logged. Skipped when the project's "Update queued tasks after a merge" is off.
 */
export function groomQueueAfterMerge(
  projectId: string,
  mergedTaskId: string,
  options: GroomOptions = { autoApplyStructural: false },
  deps: GroomingDeps = defaultDeps()
): Promise<void> {
  return serialized(`groom:${projectId}`, async () => {
    try {
      await groomNow(projectId, mergedTaskId, options, deps);
    } catch (error) {
      appLog.warn(`[QueueGrooming] Could not update the queue after ${mergedTaskId} merged:`, error);
    }
  });
}

async function groomNow(projectId: string, mergedTaskId: string, options: GroomOptions, deps: GroomingDeps): Promise<void> {
  const project = deps.getProject(projectId);
  if (!project || project.settings?.groomQueueAfterMerge === false) return;
  const settle = deps.settleMs ?? SETTLE_MS;
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));

  const tasks = deps.getTasks(projectId);
  const merged = tasks.find((t) => t.id === mergedTaskId);
  if (!merged) return;
  const candidates = tasks.filter((t) => t.id !== mergedTaskId && isGroomableStatus(t.status) && !t.metadata?.archivedAt);
  if (candidates.length === 0) return;

  let files: string[] = [];
  if (project.autoBuildPath) {
    const entries = await readTaskChangelog(getTaskChangelogPath(project.path, project.autoBuildPath));
    files = mergedFromChangelog(entries).get(merged.id)?.files ?? [];
    if (files.length === 0) files = foldTaskChangelog(entries).get(merged.id)?.files ?? [];
  }

  const raw = await deps.runModel({
    prompt: buildGroomingPrompt(merged, files, candidates),
    systemPrompt: GROOMING_SYSTEM_PROMPT,
    jsonSchema: GROOMING_SCHEMA,
    cwd: project.path,
    profileId: project.settings?.claudeProfileId,
  });

  await withStateLock(projectId, async () => {
    // The model took a while: tasks may have started or moved. Validate against the tasks as they are now
    const fresh = deps.getTasks(projectId);
    const result = normalizeGroomingResult(raw, fresh.map(toGroomTask), mergedTaskId);
    if (result.updates.length === 0 && result.newTasks.length === 0) return;

    const byId = new Map(fresh.map((t) => [t.id, t]));
    for (const update of result.updates) {
      try {
        if (update.kind === 'note') {
          await addContextNote(deps, projectId, byId.get(update.taskId)!, mergedTaskId, update.note);
          continue;
        }
        await addProposal(deps, project, {
          id: randomUUID(),
          fromTaskId: mergedTaskId,
          createdAt: new Date().toISOString(),
          reason: update.reason,
          ...(update.kind === 'obsolete'
            ? { kind: 'obsolete' as const, taskId: update.taskId }
            : { kind: 'duplicate' as const, taskId: update.taskId, duplicateOf: update.duplicateOf }),
        }, options.autoApplyStructural);
      } catch (error) {
        appLog.warn(`[QueueGrooming] Could not apply an update for ${update.taskId}:`, error);
      }
    }
    for (const card of result.newTasks) {
      try {
        await addProposal(deps, project, {
          id: randomUUID(),
          fromTaskId: mergedTaskId,
          createdAt: new Date().toISOString(),
          reason: card.reason,
          kind: 'newTask',
          title: card.title,
          description: card.description,
          dependsOn: card.dependsOn,
        }, options.autoApplyStructural);
      } catch (error) {
        appLog.warn('[QueueGrooming] Could not add a proposed task:', error);
      }
    }
    deps.changed(projectId);
  });
}

// =============================================================================
// Notes
// =============================================================================

async function addContextNote(deps: GroomingDeps, projectId: string, task: Task, fromTaskId: string, note: string): Promise<void> {
  const existing = task.metadata?.contextNotes ?? [];
  // The same merge reports the same thing once
  if (existing.some((n) => n.fromTaskId === fromTaskId && n.note === note)) return;
  const block = buildNoteBlock(fromTaskId, note);
  const entry: TaskContextNote = { id: randomUUID(), fromTaskId, note, block, at: new Date().toISOString() };
  await deps.updateTask(projectId, task.id, {
    description: appendNoteBlock(task.description, block),
    metadata: { contextNotes: [...existing, entry] },
  });
}

/** Take a context note off a ticket again: its text leaves the description */
export async function undoContextNote(
  projectId: string,
  taskId: string,
  noteId: string,
  deps: GroomingDeps = defaultDeps()
): Promise<{ success: boolean; error?: string }> {
  return withStateLock(projectId, async () => {
    const task = deps.getTasks(projectId).find((t) => t.id === taskId);
    const note = task?.metadata?.contextNotes?.find((n) => n.id === noteId);
    if (!task || !note) return { success: false, error: 'Note not found' };
    try {
      await deps.updateTask(projectId, taskId, {
        description: removeNoteBlock(task.description, note.block),
        metadata: { contextNotes: (task.metadata?.contextNotes ?? []).filter((n) => n.id !== noteId) },
      });
      deps.changed(projectId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

// =============================================================================
// Proposals
// =============================================================================

function sameProposal(a: QueueProposal, b: QueueProposal): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'newTask' && b.kind === 'newTask') return a.title.toLowerCase() === b.title.toLowerCase();
  return 'taskId' in a && 'taskId' in b && a.taskId === b.taskId;
}

async function addProposal(deps: GroomingDeps, project: Project, proposal: QueueProposal, autoApply: boolean): Promise<void> {
  const file = await readQueueProposals(project);
  if (file.proposals.some((p) => sameProposal(p, proposal))) return;
  if (autoApply) {
    const undo = await applyProposalNow(deps, project.id, proposal);
    if (undo) await writeQueueProposals(project, { ...file, undo: [...file.undo, undo] });
    return;
  }
  await writeQueueProposals(project, { ...file, proposals: [...file.proposals, proposal] });
}

/** Apply one proposal to the tasks as they are now; null when it no longer applies */
async function applyProposalNow(deps: GroomingDeps, projectId: string, proposal: QueueProposal): Promise<QueueUndoEntry | null> {
  const tasks = deps.getTasks(projectId);
  const graph = tasks.filter((t) => !t.metadata?.archivedAt).map(toGroomTask);
  const live = new Map(graph.map((t) => [t.id, t]));
  const base = { id: randomUUID(), proposal, appliedAt: new Date().toISOString() };

  if (proposal.kind === 'newTask') {
    const dependsOn = [...new Set(proposal.dependsOn.filter((id) => live.has(id)))];
    const createdTaskId = await deps.createTask(projectId, proposal.title, proposal.description, {
      sourceType: 'manual',
      ...(dependsOn.length > 0 ? { dependsOnTaskIds: dependsOn } : {}),
    });
    return { ...base, archived: [], previousDependsOn: {}, ...(createdTaskId ? { createdTaskId } : {}) };
  }

  if (proposal.kind === 'split') return applyTaskSplit(deps, projectId, proposal);

  // Obsolete and duplicate only touch tickets that still wait in Planning or the Queue
  const target = live.get(proposal.taskId);
  if (!target || !isGroomableStatus(target.status)) return null;
  const replacement = proposal.kind === 'duplicate' ? proposal.duplicateOf : undefined;
  if (replacement && !live.has(replacement)) return null;

  const plan = planArchive(graph, proposal.taskId, replacement);
  const previousDependsOn: Record<string, string[]> = {};
  for (const [id, next] of Object.entries(plan.setDependsOn)) {
    previousDependsOn[id] = live.get(id)?.dependsOn ?? [];
    await deps.updateTask(projectId, id, { metadata: { dependsOnTaskIds: next } });
  }
  deps.archive(projectId, plan.archive);
  return { ...base, archived: plan.archive, previousDependsOn };
}

export async function listQueueProposals(projectId: string, deps: GroomingDeps = defaultDeps()): Promise<QueueProposal[]> {
  const project = deps.getProject(projectId);
  if (!project) return [];
  return (await readQueueProposals(project)).proposals;
}

/** Apply a pending proposal (the user pressed Apply) */
export function applyQueueProposal(
  projectId: string,
  proposalId: string,
  deps: GroomingDeps = defaultDeps()
): Promise<{ success: boolean; error?: string }> {
  return withStateLock(projectId, async () => {
    const project = deps.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const file = await readQueueProposals(project);
    const proposal = file.proposals.find((p) => p.id === proposalId);
    if (!proposal) return { success: false, error: 'Proposal not found' };
    try {
      const undo = await applyProposalNow(deps, projectId, proposal);
      // Applied or no longer applicable: either way it leaves the list
      const remaining = file.proposals.filter((p) => p.id !== proposalId);
      await writeQueueProposals(project, { ...file, proposals: remaining, undo: undo ? [...file.undo, undo] : file.undo });
      deps.changed(projectId);
      return undo ? { success: true } : { success: false, error: 'The ticket changed since this was proposed' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function dismissQueueProposal(
  projectId: string,
  proposalId: string,
  deps: GroomingDeps = defaultDeps()
): Promise<{ success: boolean; error?: string }> {
  return withStateLock(projectId, async () => {
    const project = deps.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const file = await readQueueProposals(project);
    await writeQueueProposals(project, { ...file, proposals: file.proposals.filter((p) => p.id !== proposalId) });
    deps.changed(projectId);
    return { success: true };
  });
}

/** Undo a structural change that was applied (autonomous mode keeps these entries) */
export function undoQueueChange(
  projectId: string,
  undoId: string,
  deps: GroomingDeps = defaultDeps()
): Promise<{ success: boolean; error?: string }> {
  return withStateLock(projectId, async () => {
    const project = deps.getProject(projectId);
    if (!project) return { success: false, error: 'Project not found' };
    const file = await readQueueProposals(project);
    const entry = file.undo.find((u) => u.id === undoId);
    if (!entry) return { success: false, error: 'Nothing to undo' };
    try {
      if (entry.splitTask) {
        await undoTaskSplit(deps, projectId, entry);
        await writeQueueProposals(project, { ...file, undo: file.undo.filter((u) => u.id !== undoId) });
        deps.changed(projectId);
        return { success: true };
      }
      if (entry.archived.length > 0) deps.unarchive(projectId, entry.archived);
      for (const [taskId, previous] of Object.entries(entry.previousDependsOn)) {
        await deps.updateTask(projectId, taskId, { metadata: { dependsOnTaskIds: previous } });
      }
      if (entry.createdTaskId) deps.archive(projectId, [entry.createdTaskId]);
      await writeQueueProposals(project, { ...file, undo: file.undo.filter((u) => u.id !== undoId) });
      deps.changed(projectId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}


// =============================================================================
// Task splits (a task moves part of its scope into new tickets)
// =============================================================================

export type SplitSubmission =
  | { outcome: 'applied'; description: string }
  | { outcome: 'proposed'; proposalId: string }
  | { outcome: 'ignored'; reason: string };

/**
 * A task's split, from the plan step or the end of implementing. `auto` applies it at once and
 * keeps an undo entry; `propose` stores it as a proposal (the Queue updates panel applies or
 * dismisses it). Never throws.
 */
export function submitTaskSplit(
  projectId: string,
  taskId: string,
  split: NormalizedSplit,
  origin: SplitProposal['origin'],
  mode: 'propose' | 'auto',
  deps: GroomingDeps = defaultDeps()
): Promise<SplitSubmission> {
  return withStateLock(projectId, async (): Promise<SplitSubmission> => {
    try {
      const project = deps.getProject(projectId);
      if (!project) return { outcome: 'ignored', reason: 'Project not found' };
      const proposal: SplitProposal = {
        id: randomUUID(),
        kind: 'split',
        fromTaskId: taskId,
        taskId,
        createdAt: new Date().toISOString(),
        reason: split.reason,
        keepScope: split.keepScope,
        pieces: split.pieces,
        origin,
      };
      const file = await readQueueProposals(project);
      if (mode === 'propose') {
        // Only one split proposal per task is waiting
        const rest = file.proposals.filter((p) => !(p.kind === 'split' && p.taskId === taskId));
        await writeQueueProposals(project, { ...file, proposals: [...rest, proposal] });
        deps.changed(projectId);
        appLog.info(`[TaskSplit] ${taskId} proposed a split into ${split.pieces.length} new ticket(s)`);
        return { outcome: 'proposed', proposalId: proposal.id };
      }
      const undo = await applyProposalNow(deps, projectId, proposal);
      if (!undo) return { outcome: 'ignored', reason: 'The ticket can no longer be split' };
      await writeQueueProposals(project, { ...file, undo: [...file.undo, undo] });
      deps.changed(projectId);
      const description = deps.getTasks(projectId).find((t) => t.id === taskId)?.description ?? '';
      return { outcome: 'applied', description };
    } catch (error) {
      appLog.warn(`[TaskSplit] Could not split ${taskId}:`, error);
      return { outcome: 'ignored', reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

/**
 * Drop a task's undecided split proposals. A proposal belongs to the run that made it, so Start
 * over (which throws that run away) must not leave one behind that could split the new run later.
 */
export function dropSplitProposalsForTask(
  projectId: string,
  taskId: string,
  deps: GroomingDeps = defaultDeps()
): Promise<number> {
  return withStateLock(projectId, async () => {
    const project = deps.getProject(projectId);
    if (!project) return 0;
    const file = await readQueueProposals(project);
    const rest = file.proposals.filter((p) => !(p.kind === 'split' && p.taskId === taskId));
    const dropped = file.proposals.length - rest.length;
    if (dropped > 0) {
      await writeQueueProposals(project, { ...file, proposals: rest });
      deps.changed(projectId);
      appLog.info(`[TaskSplit] Dropped ${dropped} undecided split proposal(s) of ${taskId}: the task starts over`);
    }
    return dropped;
  });
}

/**
 * What became of a split proposal a paused task waits for: still pending in the Queue updates
 * panel, applied (the task carries `splitInto` for it), or dismissed (gone without being applied).
 */
export async function getSplitStatus(
  projectId: string,
  taskId: string,
  proposalId: string,
  deps: GroomingDeps = defaultDeps()
): Promise<'pending' | 'applied' | 'dismissed'> {
  const project = deps.getProject(projectId);
  if (!project) return 'dismissed';
  const task = deps.getTasks(projectId).find((t) => t.id === taskId);
  if (task?.metadata?.splitInto?.proposalId === proposalId) return 'applied';
  const file = await readQueueProposals(project);
  return file.proposals.some((p) => p.id === proposalId) ? 'pending' : 'dismissed';
}
