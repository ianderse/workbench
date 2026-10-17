/**
 * The standing instruction that makes a session save what it learns.
 *
 * Claude Code's auto memory already stores and loads the notes; left to itself it decides to write
 * one only rarely, so a session that just got corrected usually forgets the correction. This text
 * states when to save, the bar for saving, and what to do when a new preference contradicts an old
 * one. It is appended to the system prompt of the runs Workbench starts and placed in the project
 * for the sessions it doesn't start.
 */

/**
 * Appended to a task run's system prompt and, flattened, to an agent window's
 * `--append-system-prompt`.
 *
 * Written without apostrophes on purpose: the agent-window flag is wrapped in shell single quotes,
 * and rewriting the text to escape them would change the instruction the model reads.
 */
export const SELF_IMPROVE_NUDGE = `## Project memory
This project keeps what you learn about it in its own memory directory, loaded into every later session.

- Save a memory (\`type: feedback\`) when this session surfaces a durable preference, rule or convention the user stated: something a later session would otherwise get wrong again. A correction the user has had to give more than once is the strongest signal.
- Do not save what the code, tests, types or CLAUDE.md already make clear, and do not save detail that only matters for this task.
- When a new preference contradicts an existing memory, the newer one wins: update that memory in place so only one remains. Never leave both.
- Write it as a general instruction in the words the user used, never as a quote of the conversation, and never record secrets or credentials.`;

/** The same text on one line, for a flag that is written into a shell command */
export const SELF_IMPROVE_NUDGE_ONE_LINE = SELF_IMPROVE_NUDGE.replace(/\s+/g, ' ').trim();

/**
 * The same instruction as a project rule file, for the sessions Workbench doesn't start (a plain
 * `claude` in the project). A rule file with no `paths` frontmatter loads at launch, at the same
 * priority as the project's CLAUDE.md.
 */
export const SELF_IMPROVE_RULE_FILE = `${SELF_IMPROVE_NUDGE}\n`;

/** Name of that rule file under `.claude/rules/` */
export const SELF_IMPROVE_RULE_FILENAME = 'workbench-project-memory.md';
