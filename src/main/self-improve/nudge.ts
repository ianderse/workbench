/**
 * The standing instruction that makes a session save what it learns.
 *
 * Claude Code's auto memory already stores and loads the notes; left to itself it decides to write
 * one only rarely, so a session that just got corrected usually forgets the correction. This text
 * states when to save, the bar for saving, and what to do when a new preference contradicts an old
 * one. It is appended to the system prompt of the runs Workbench starts and placed in the project's
 * `.claude/MEMORY.md` for the sessions it doesn't start.
 */

/**
 * Appended to a task run's system prompt and, flattened, to an agent window's
 * `--append-system-prompt`.
 *
 * Written without apostrophes or double quotes on purpose (example phrases are plain words): the
 * agent-window flag is wrapped in single quotes in POSIX shells and in double quotes in cmd, and
 * escaping them would change the instruction the model reads.
 */
export const SELF_IMPROVE_NUDGE = `## Project memory
This project keeps what you learn about it in its own memory directory, loaded into every later session. Save a memory (\`type: feedback\`) when the user tells you how work in this project should be done beyond the current task. Save it when it comes up, without asking, and say in one short line that you saved it.

How to recognize one:
- Standing wording: always, never, from now on, going forward, every time, whenever, by default, as a rule, in general, in this project, make sure to, stop doing, do not ever, remember that, keep in mind, next time.
- A stated preference or convention: I prefer, I like it when, I want, we use, we do not, our convention is, the rule here is, the way we do this is.
- Repetition: a correction the user has given before in this project, or wording such as again, as I said, I already told you, how many times. This is the strongest signal.
- Approval of a choice that was not obvious: yes exactly like that, perfect, keep doing it this way.
- No signal words at all: ask whether a later session, working on a different task, would make the same mistake. If it would, save it.

What not to save:
- One-off instructions scoped to the current work: for this task, just this once, for now, this time, here, in this file, or anything that only concerns the change at hand.
- What the code, tests, types or CLAUDE.md already make clear, and detail that only matters for this task.

How to save it:
- Check the existing memories first. When a new preference contradicts or refines one, the newer one wins: update that memory in place so only one remains. Never leave both.
- Write it as a general instruction in the words the user used, never as a quote of the conversation, with the reason when the user gave one, and never record secrets or credentials.`;

/** The same text on one line, for a flag that is written into a shell command */
export const SELF_IMPROVE_NUDGE_ONE_LINE = SELF_IMPROVE_NUDGE.replace(/\s+/g, ' ').trim();

/**
 * The same instruction as a project memory file, for the sessions Workbench doesn't start (a plain
 * `claude` in the project). It sits at `.claude/MEMORY.md`, beside the project's other Claude Code
 * files.
 */
export const SELF_IMPROVE_MEMORY_FILE = `${SELF_IMPROVE_NUDGE}\n`;

/** Name of that file inside the project's `.claude` directory */
export const SELF_IMPROVE_MEMORY_FILENAME = 'MEMORY.md';
