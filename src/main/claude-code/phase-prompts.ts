/**
 * The openings of the turns Workbench itself sends a task run, phase by phase.
 *
 * They live here, apart from the prompts they begin, because two places need the same strings:
 * `buildInput()` in `task-runner.ts` composes the turns from them, and the memory backfill
 * (`self-improve/transcripts.ts`) drops transcript turns that start with one. Those turns are the
 * app talking to Claude Code rather than the user talking, and a "preference" learned from one
 * would be a memory of Workbench's own instructions stated as if the user had asked for it.
 *
 * Keeping one copy is what makes the filter safe to rely on: a reworded prompt changes both sides
 * at once instead of silently leaving the backfill matching text that is no longer sent.
 *
 * The phases whose turn opens with the `<task>` block need nothing here - the backfill already
 * drops a turn that opens with a tag.
 */
export const PHASE_PROMPT_OPENINGS = {
  /** `implement`, resuming a session that already did some of the work */
  continuing: 'Continue the task from where you left off.',
  /** `implement`, resuming the session that planned */
  planApproved: 'The plan is approved. Implement it now',
  /** `validate` */
  validate: 'Before handing this off, validate the work:',
  /** `revise` */
  revise: 'The reviewer requested changes:',
} as const;

/** Every opening, for matching a transcript turn against all of them */
export const PHASE_PROMPT_OPENING_LIST: readonly string[] = Object.values(PHASE_PROMPT_OPENINGS);
