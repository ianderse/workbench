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
  /** `resync`: the task's base branch moved on and the session merges it in */
  resync: 'Your base branch moved on:',
  /** `resync`, second pass after Workbench checked the merge */
  resyncCheck: 'Workbench checked your merge and found problems:',
} as const;

/** Every opening, for matching a transcript turn against all of them */
export const PHASE_PROMPT_OPENING_LIST: readonly string[] = Object.values(PHASE_PROMPT_OPENINGS);

/** Execution guidance shared by the Claude Code and OMP task system prompts. */
export const TASK_EXECUTION_GUIDANCE = `- Use targeted edits for existing files. Do not regenerate a large file to change a few sections; preserve unrelated code, comments, and concurrent changes. For a genuinely new large file, write coherent sections and then patch them instead of repeatedly emitting the entire file.
- After interruption or compaction, use the saved plan, current diff, and focused reads to recover what is already implemented. Continue from that state; do not rewrite completed modules or repeat checks whose results still apply to the current revision.
- Keep routine reads, searches, status checks, and test execution direct. Spend deeper reasoning on unresolved design choices, correctness failures, concurrency, and security boundaries. Stop re-planning once the next safe change or check is clear; investigate further when new evidence changes the decision.
- Keep test execution bounded: Vitest commands, including npm test scripts that invoke it, use at most two workers (one when other work is busy). Run broad suites one at a time in the foreground; subagents leave the final full suite to the parent. If a test command is interrupted or times out, settle its owned processes before retrying. An interrupted run is not a passing check.
- When another task owns a coupled interface or foundational module, coordinate the smallest required change instead of independently redesigning it. Preserve independent parallel work and all required checks, review, recovery, and human-acceptance gates.`;

/**
 * How the turns Workbench writes into a session start (`formatMessage()` in
 * `task-messaging/broker.ts`): notices and peer messages, never something the user said. The
 * memory backfill drops them like phase prompts.
 */
export const WORKBENCH_TURN_PREFIXES: readonly string[] = ['[Workbench]', '[Message from task '];

/** Marker Workbench adds to every message it writes to a running session's stdin */
export const WORKBENCH_INPUT_MARKER_PATTERN = /\[Workbench message wbm-[A-Za-z0-9_-]+\]/;
