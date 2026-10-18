/**
 * Self-improve projects: Claude Code's auto memory, pointed at the project and told when to write.
 *
 * Claude Code already saves typed notes from the user's corrections and loads them at the start of
 * every session; what it lacks is a reason to save one, and a location the whole project shares.
 * This module supplies both.
 *
 * Importing this file reaches the app logger, and through it electron, so a caller that only needs
 * to read the project's switch imports `./setting` directly instead.
 */

export { SELF_IMPROVE_NUDGE } from './nudge';
export { applyProjectMemory, removeProjectMemory } from './relocation';
export { isSelfImproveEnabled } from './setting';
