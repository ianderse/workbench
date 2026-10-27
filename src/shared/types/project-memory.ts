/** Workbench-owned memories. Task state and approvals continue to live in their own records. */
export type MemoryKind = 'decision' | 'lesson' | 'procedure' | 'preference';
export type MemoryStatus = 'proposed' | 'active' | 'obsolete' | 'deleted';

export interface MemorySource {
  /** A task spec id, a repo-relative file (optionally :line), or an explicit user instruction. */
  type: 'task' | 'file' | 'user';
  reference: string;
  /** Supporting observation, check output, or reasoning; never inferred by Workbench. */
  evidence: string;
  commit?: string;
  /** Exact citation used for automatic retention, checked against the committed file by Workbench. */
  file?: string;
  quote?: string;
}

export interface MemoryContent {
  kind: MemoryKind;
  title: string;
  body: string;
  source: MemorySource;
}

export interface MemoryRevision extends MemoryContent {
  revision: number;
  status: MemoryStatus;
  at: string;
  /** Human acceptance confirms the entry; source-backed retention checks documentation, never runtime claims. */
  verification: 'unverified' | 'user-confirmed' | 'source-backed';
  reviewReason?: 'conflict' | 'procedure' | 'preference' | 'unverified';
  conflictsWith?: string[];
}

export interface ProjectMemory extends MemoryRevision {
  id: string;
  projectId: string;
  /** New entries may replace an older entry. Both histories are kept. */
  supersedes?: string;
  history: MemoryRevision[];
}

export type MemoryMutation =
  | { action: 'propose'; requestId: string; content: MemoryContent; supersedes?: string }
  | { action: 'revise'; id: string; expectedRevision: number; content: MemoryContent }
  | { action: 'resolve'; id: string; expectedRevision: number; conflicts: Array<{ id: string; revision: number }> }
  | { action: 'accept' | 'obsolete' | 'delete'; id: string; expectedRevision: number };

export interface MemoryContextItem {
  id: string;
  revision: number;
  title: string;
  body: string;
  source: MemorySource;
  verification: MemoryRevision['verification'] | 'legacy-unverified';
  /** Recall may quote an excerpt; the source record and context receipt remain explicit about it. */
  truncated?: boolean;
  disputedBy?: string[];
}

export interface MemoryContextPacket {
  version: 1;
  projectId: string;
  taskId: string;
  phase: string;
  at: string;
  /** Approximation based on UTF-8 bytes / 3, with a hard byte ceiling on the whole prompt. */
  estimatedTokens: number;
  prompt: string;
  items: MemoryContextItem[];
}
