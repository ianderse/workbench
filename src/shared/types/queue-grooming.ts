/** Queue grooming: what a merged task means for the tickets that were written before it landed */

/** A short context note added to a ticket after another task merged (applied automatically, can be undone) */
export interface TaskContextNote {
  id: string;
  /** Task whose merge caused the note */
  fromTaskId: string;
  note: string;
  /** The exact text appended to the task's description (removed again on undo) */
  block: string;
  /** ISO time */
  at: string;
  /** 'split': written by a task split (fromTaskId is the task itself); undone with the split, not on its own */
  kind?: 'split';
}

interface QueueProposalBase {
  id: string;
  /** Task whose merge caused the proposal */
  fromTaskId: string;
  reason: string;
  /** ISO time */
  createdAt: string;
}

export interface ObsoleteProposal extends QueueProposalBase {
  kind: 'obsolete';
  taskId: string;
}

export interface DuplicateProposal extends QueueProposalBase {
  kind: 'duplicate';
  /** The ticket to archive */
  taskId: string;
  /** The ticket that stays; dependents of `taskId` move onto it */
  duplicateOf: string;
}

export interface NewTaskProposal extends QueueProposalBase {
  kind: 'newTask';
  title: string;
  description: string;
  /** Ids of existing tasks the new card waits for */
  dependsOn: string[];
}

/** One new ticket a split moves out of a task */
export interface SplitPiece {
  title: string;
  /** Self-contained: the agent working it sees nothing else */
  description: string;
  reason: string;
}

/** A task moves part of its scope into new tickets (see shared/utils/task-split.ts) */
export interface SplitProposal extends QueueProposalBase {
  kind: 'split';
  /** The task that splits (also `fromTaskId`) */
  taskId: string;
  /** What the task still does; becomes its description */
  keepScope: string;
  pieces: SplitPiece[];
  /** Where the split came from: the plan step, or the end of implementing (deferred work) */
  origin: 'plan' | 'implement';
}

export type QueueProposal = ObsoleteProposal | DuplicateProposal | NewTaskProposal | SplitProposal;

/** Kept on a task that split (`metadata.splitInto`), so the card and detail can show it and undo can restore it */
export interface TaskSplitRecord {
  /** Proposal or undo id that applied the split */
  proposalId: string;
  /** The new tickets, in order */
  taskIds: string[];
  /** The task's description before the split (restored on undo) */
  originalDescription: string;
  /** ISO time */
  at: string;
}

/** What applying a structural proposal changed, so it can be undone */
export interface QueueUndoEntry {
  id: string;
  proposal: QueueProposal;
  /** ISO time */
  appliedAt: string;
  /** Tasks the proposal archived */
  archived: string[];
  /** Previous `dependsOnTaskIds` of every task the proposal changed */
  previousDependsOn: Record<string, string[]>;
  /** Card the proposal created */
  createdTaskId?: string;
  /** Split: the cards it created (archived again on undo while none of them started) */
  createdTaskIds?: string[];
  /** Split: the task that split, with its description before the split */
  splitTask?: { taskId: string; originalDescription: string; contextNoteIds: string[] };
}

/** `.workbench/queue-proposals.json` */
export interface QueueProposalsFile {
  version: 1;
  proposals: QueueProposal[];
  /** Structural changes that were applied without asking (newest last, capped) */
  undo: QueueUndoEntry[];
}

/** One entry of the model's answer, after normalisation */
export type GroomingUpdate =
  | { taskId: string; kind: 'note'; note: string; reason: string }
  | { taskId: string; kind: 'obsolete'; reason: string }
  | { taskId: string; kind: 'duplicate'; duplicateOf: string; reason: string };

export interface GroomingNewTask {
  title: string;
  description: string;
  dependsOn: string[];
  reason: string;
}

export interface GroomingResult {
  updates: GroomingUpdate[];
  newTasks: GroomingNewTask[];
}
