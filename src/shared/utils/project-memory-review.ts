import type { ProjectMemory } from '../types/project-memory';

/** Keep unresolved conflicts visible even when their referenced entry changed. */
export function memoryHasConflict(entry: ProjectMemory, entries: readonly ProjectMemory[]): boolean {
  return entry.status === 'proposed' && (entry.reviewReason === 'conflict'
    || !!entry.conflictsWith?.some((id) => entries.some((other) => other.id === id && other.status === 'active'))
    || !!entry.supersedes && entries.some((other) => other.id === entry.supersedes && other.status === 'active'));
}

/** Optional task suggestions are available in management without interrupting work. */
export function memoryNeedsDecision(entry: ProjectMemory, entries: readonly ProjectMemory[]): boolean {
  return entry.status === 'proposed' && (memoryHasConflict(entry, entries) || entry.source.type === 'user');
}
