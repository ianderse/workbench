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

export type QueueProposal = ObsoleteProposal | DuplicateProposal | NewTaskProposal;

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
