/**
 * Task splitting: the effects
 * ===========================
 *
 * `applyTaskSplit()` turns a split (what the ticket keeps, the pieces it hands off) into tickets:
 *   - creates the pieces at the top of the Queue, piece 1 waiting for the split task and each later
 *     piece for the one before it,
 *   - rewires the tickets that waited on the split task onto the last piece,
 *   - rewrites the split task's description to the reduced scope (original kept in a collapsed
 *     block) and adds a note saying what moved where.
 * `undoTaskSplit()` reverses that while no piece has started. The rules are pure in
 * shared/utils/task-split.ts; every effect goes through `GroomingDeps`, so tests run it without Electron.
 */
import { randomUUID } from 'crypto';
import type { Task, TaskMetadata } from '../shared/types';
import type { QueueUndoEntry, SplitProposal, TaskContextNote } from '../shared/types/queue-grooming';
import {
  buildSplitDescription,
  buildSplitNote,
  buildSplitNoteBlock,
  pieceDependsOn,
  planSplitRewire,
} from '../shared/utils/task-split';
import type { GroomingDeps } from './queue-grooming';
import { appLog } from './app-logger';

/** Statuses from which a piece can still be taken back: it has not started */
const UNSTARTED = new Set(['backlog', 'queue']);

/** Fields a new piece inherits from the task it came from, like a normal create would give it */
export function inheritedMetadata(metadata: TaskMetadata | undefined): Partial<TaskMetadata> {
  const inherited: Partial<TaskMetadata> = {};
  if (metadata?.agentOverride) inherited.agentOverride = metadata.agentOverride;
  if (metadata?.mcpConnectors) inherited.mcpConnectors = metadata.mcpConnectors;
  if (metadata?.baseBranch) inherited.baseBranch = metadata.baseBranch;
  // The branch is a choice the piece keeps (autonomous mode bases and merges it there too); the branch exists by now
  if (metadata?.baseBranchChosen) inherited.baseBranchChosen = true;
  if (metadata?.useLocalBranch !== undefined) inherited.useLocalBranch = metadata.useLocalBranch;
  if (metadata?.pushNewBranches !== undefined) inherited.pushNewBranches = metadata.pushNewBranches;
  if (metadata?.useWorktree !== undefined) inherited.useWorktree = metadata.useWorktree;
  return inherited;
}

/**
 * Apply a split to the tasks as they are now; null when it no longer applies (the task is gone,
 * archived, done, was made by a split or split already).
 */
export async function applyTaskSplit(
  deps: GroomingDeps,
  projectId: string,
  proposal: SplitProposal,
  now: Date = new Date()
): Promise<QueueUndoEntry | null> {
  const tasks = deps.getTasks(projectId);
  const task = tasks.find((t) => t.id === proposal.taskId);
  if (!task || task.metadata?.archivedAt || task.status === 'done') return null;
  if (task.metadata?.splitFrom || task.metadata?.splitInto) return null;
  if (proposal.pieces.length === 0) return null;

  // Graph as it is before the pieces exist: only tickets that waited on the task are rewired
  const graph = tasks
    .filter((t) => !t.metadata?.archivedAt)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.metadata?.dependsOnTaskIds ?? [] }));

  const createdIds: string[] = [];
  try {
    for (let i = 0; i < proposal.pieces.length; i++) {
      const piece = proposal.pieces[i];
      const id = await deps.createTask(projectId, piece.title, piece.description, {
        ...inheritedMetadata(task.metadata),
        sourceType: 'manual',
        dependsOnTaskIds: pieceDependsOn(task.id, createdIds, i),
        splitFrom: task.id,
      });
      if (!id) throw new Error('Could not create a ticket for the split');
      createdIds.push(id);
    }
    // Pieces go to the top of the Queue, in order. They cannot start before the split task is done
    await deps.queueTasks?.(projectId, createdIds);
  } catch (error) {
    if (createdIds.length > 0) deps.archive(projectId, createdIds);
    throw error;
  }

  const lastPieceId = createdIds[createdIds.length - 1];
  const rewire = planSplitRewire(graph, task.id, lastPieceId);
  const previousDependsOn: Record<string, string[]> = {};
  for (const [id, next] of Object.entries(rewire)) {
    previousDependsOn[id] = graph.find((t) => t.id === id)?.dependsOn ?? [];
    await deps.updateTask(projectId, id, { metadata: { dependsOnTaskIds: next } });
  }

  const note = buildSplitNote(now, proposal.pieces, createdIds);
  const noteEntry: TaskContextNote = {
    id: randomUUID(),
    fromTaskId: task.id,
    note,
    block: buildSplitNoteBlock(note),
    at: now.toISOString(),
    kind: 'split',
  };
  const originalDescription = task.description ?? '';
  const description = `${buildSplitDescription(proposal.keepScope, originalDescription)}${noteEntry.block}`;
  await deps.updateTask(projectId, task.id, {
    description,
    metadata: {
      splitInto: { proposalId: proposal.id, taskIds: createdIds, originalDescription, at: now.toISOString() },
      contextNotes: [...(task.metadata?.contextNotes ?? []), noteEntry],
    },
  });

  appLog.info(`[TaskSplit] ${task.id} split: ${note}`);
  return {
    id: randomUUID(),
    proposal,
    appliedAt: now.toISOString(),
    archived: [],
    previousDependsOn,
    createdTaskIds: createdIds,
    splitTask: { taskId: task.id, originalDescription, contextNoteIds: [noteEntry.id] },
  };
}

/**
 * Take a split back: archive the pieces, give the dependents their old dependencies and restore
 * the description. Refuses (changing nothing) when a piece already started.
 */
export async function undoTaskSplit(deps: GroomingDeps, projectId: string, entry: QueueUndoEntry): Promise<void> {
  const split = entry.splitTask;
  if (!split) return;
  const tasks = deps.getTasks(projectId);
  const pieces = (entry.createdTaskIds ?? [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t && !t.metadata?.archivedAt);
  const started = pieces.find((t) => !UNSTARTED.has(t.status));
  if (started) throw new Error(`"${started.title}" already started, so the split can no longer be undone`);

  for (const [taskId, previous] of Object.entries(entry.previousDependsOn)) {
    await deps.updateTask(projectId, taskId, { metadata: { dependsOnTaskIds: previous } });
  }
  if (pieces.length > 0) deps.archive(projectId, pieces.map((t) => t.id));
  const task = tasks.find((t) => t.id === split.taskId);
  if (task) {
    await deps.updateTask(projectId, task.id, {
      description: split.originalDescription,
      metadata: {
        splitInto: undefined,
        contextNotes: (task.metadata?.contextNotes ?? []).filter((n) => !split.contextNoteIds.includes(n.id)),
      },
    });
  }
}
