/** "Break into tasks": a big prompt turned into several dependent task cards */

export interface BreakdownTask {
  /** Short id inside the breakdown, e.g. "t1" */
  key: string;
  title: string;
  /** Self-contained: each card runs in its own session */
  description: string;
  /** Keys of the tasks of this breakdown that must be merged first */
  dependsOn: string[];
  /** Ids of existing open tickets that must be merged first (queue gating waits for them) */
  dependsOnExisting?: string[];
}

/** An existing ticket that is not merged yet, so a new ticket can wait for it */
export interface OpenTicketRef {
  id: string;
  title: string;
  status: string;
  /** Short description, for the model */
  description?: string;
}

export interface TaskBreakdown {
  tasks: BreakdownTask[];
  /** The open tickets the model could depend on (the review step offers them per task) */
  openTickets?: OpenTicketRef[];
  /** Id of the spec batch these tasks belong to (Spec review loop) */
  batchId?: string;
  /** Spec files the prompt referenced; empty when the prompt itself is the spec */
  specSources?: string[];
  /** The stored proposal of this result (Queue updates panel); removed once the tickets are created or discarded */
  proposalId?: string;
}
