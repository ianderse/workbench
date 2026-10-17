/**
 * Where a project keeps the preferences Claude Code learns about it (its "self-learning" folder),
 * without the rest of the self-learning integration.
 *
 * Deliberately NOT `.workbench/knowledge`: that folder's existence is what turns the project's
 * "Use Graphify" switch on (`graphify-paths.ts`), so sharing it would enable Graphify by accident.
 */

import path from 'path';

/** The folder under `.workbench` that holds the learned preferences */
export const LEARNING_DIR_NAME = 'learning';

/**
 * Claude Code's auto memory directory for a project: where it writes the notes it takes from the
 * user's corrections, and reads them back at the start of every later session. Pointing its
 * `autoMemoryDirectory` setting here replaces the default `~/.claude/projects/<project>/memory`.
 */
export function getLearningDir(projectPath: string): string {
  return path.join(projectPath, '.workbench', LEARNING_DIR_NAME);
}

/** The memory index inside the learning directory (one line per memory, loaded every session) */
export function getMemoryIndexPath(projectPath: string): string {
  return path.join(getLearningDir(projectPath), 'MEMORY.md');
}

/**
 * Where the memories wait while the switch is off.
 *
 * Switching off stops pointing Claude Code at the learning directory, so anything left there would be
 * orphaned: invisible to every session, while new notes accumulate in Claude Code's own default
 * location. Moving them aside instead keeps one live store at a time and makes switching back a
 * restore rather than a fresh start.
 */
export function getStashedLearningDir(projectPath: string): string {
  return path.join(projectPath, '.workbench', `${LEARNING_DIR_NAME}.disabled`);
}

/** The learning directory as an import target, relative to a file at the project root */
export function getMemoryIndexImportPath(): string {
  return `.workbench/${LEARNING_DIR_NAME}/MEMORY.md`;
}
