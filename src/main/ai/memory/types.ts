/**
 * Memory System — TypeScript Types
 *
 * All types for the libSQL-backed memory system.
 */

// ============================================================
// CORE UNION TYPES
// ============================================================

export type MemoryType =
  // Core
  | 'gotcha'
  | 'decision'
  | 'preference'
  | 'pattern'
  | 'requirement'
  | 'error_pattern'
  | 'module_insight'
  // Active loop
  | 'prefetch_pattern'
  | 'work_state'
  | 'causal_dependency'
  | 'task_calibration'
  // V3+
  | 'e2e_observation'
  | 'dead_end'
  | 'work_unit_outcome'
  | 'workflow_recipe'
  | 'context_cost';

export type MemorySource =
  | 'agent_explicit'
  | 'observer_inferred'
  | 'qa_auto'
  | 'mcp_auto'
  | 'commit_auto'
  | 'user_taught';

export type MemoryScope = 'global' | 'module' | 'work_unit' | 'session';

export type UniversalPhase =
  | 'define'
  | 'implement'
  | 'validate'
  | 'refine'
  | 'explore'
  | 'reflect';

// ============================================================
// CORE INTERFACES
// ============================================================

export interface WorkUnitRef {
  methodology: string;
  hierarchy: string[];
  label: string;
}

export interface MemoryRelation {
  targetMemoryId?: string;
  targetFilePath?: string;
  relationType: 'required_with' | 'conflicts_with' | 'validates' | 'supersedes' | 'derived_from';
  confidence: number;
  autoExtracted: boolean;
}

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  tags: string[];
  relatedFiles: string[];
  relatedModules: string[];
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;

  workUnitRef?: WorkUnitRef;
  scope: MemoryScope;

  // Provenance
  source: MemorySource;
  sessionId: string;
  commitSha?: string;
  provenanceSessionIds: string[];

  // Knowledge graph link
  targetNodeId?: string;
  impactedNodeIds?: string[];

  // Relations
  relations?: MemoryRelation[];

  // Decay
  decayHalfLifeDays?: number;

  // Trust
  needsReview?: boolean;
  userVerified?: boolean;
  citationText?: string;
  pinned?: boolean;
  methodology?: string;

  // Chunking metadata for AST-chunked code memories
  chunkType?: 'function' | 'class' | 'module' | 'prose';
  chunkStartLine?: number;
  chunkEndLine?: number;
  contextPrefix?: string;
  embeddingModelId?: string;

  // DB fields
  projectId: string;
  trustLevelScope?: string;
  deprecated?: boolean;
  deprecatedAt?: string;
  staleAt?: string;
}

export interface MemoryService {
  store(entry: MemoryRecordEntry): Promise<string>;
  search(filters: MemorySearchFilters): Promise<Memory[]>;
  searchByPattern(pattern: string): Promise<Memory | null>;
  insertUserTaught(content: string, projectId: string, tags: string[]): Promise<string>;
  searchWorkflowRecipe(taskDescription: string, opts?: { limit?: number }): Promise<Memory[]>;
  updateAccessCount(memoryId: string): Promise<void>;
  deprecateMemory(memoryId: string): Promise<void>;
  verifyMemory(memoryId: string): Promise<void>;
  pinMemory(memoryId: string, pinned: boolean): Promise<void>;
  deleteMemory(memoryId: string): Promise<void>;
}

// ============================================================
// SEARCH + RECORD INTERFACES
// ============================================================

export interface MemorySearchFilters {
  query?: string;
  types?: MemoryType[];
  sources?: MemorySource[];
  scope?: MemoryScope;
  relatedFiles?: string[];
  relatedModules?: string[];
  projectId?: string;
  phase?: UniversalPhase;
  minConfidence?: number;
  limit?: number;
  sort?: 'relevance' | 'recency' | 'confidence';
  excludeDeprecated?: boolean;
  filter?: (memory: Memory) => boolean;
}

export interface MemoryRecordEntry {
  type: MemoryType;
  content: string;
  confidence?: number;
  tags?: string[];
  relatedFiles?: string[];
  relatedModules?: string[];
  scope?: MemoryScope;
  source?: MemorySource;
  sessionId?: string;
  projectId: string;
  workUnitRef?: WorkUnitRef;
  methodology?: string;
  decayHalfLifeDays?: number;
  needsReview?: boolean;
  pinned?: boolean;
  citationText?: string;
  chunkType?: 'function' | 'class' | 'module' | 'prose';
  chunkStartLine?: number;
  chunkEndLine?: number;
  contextPrefix?: string;
  trustLevelScope?: string;
}

