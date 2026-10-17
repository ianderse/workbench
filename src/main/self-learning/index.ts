/**
 * Self-learning projects: Claude Code's auto memory, pointed at the project and told when to write.
 *
 * Claude Code already saves typed notes from the user's corrections and loads them at the start of
 * every session; what it lacks is a reason to save one, and a location the whole project shares.
 * This module supplies both. See PLAN.md for the design and what was deliberately left out.
 */

export { SELF_LEARNING_NUDGE } from './nudge';
export { applyProjectMemory, removeProjectMemory } from './relocation';

/** Whether the project learns from its sessions (its "Self-learning" switch; off unless set) */
export function isSelfLearningEnabled(settings: { selfLearning?: boolean } | undefined): boolean {
  return settings?.selfLearning === true;
}
