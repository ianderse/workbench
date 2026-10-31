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

- Capture a durable preference, rule or convention the user stated (legacy kind \`type: feedback\`): something a later session would otherwise get wrong again. A correction the user has had to give more than once is the strongest signal.
- When \`propose_project_memory\` is available, use it instead of writing memory files: propose a compact decision, lesson, procedure or preference with its source evidence and unresolved limits. Workbench checks exact committed documentation citations for automatic retention at completion and merge; conflicts, uncertain claims, preferences and procedures need human review. A proposal is not accepted knowledge. Do not edit Workbench memory ledgers or bypass that review.
- If the capture tool is unavailable, describe the proposed memory and evidence in the final summary for Workbench to consider at completion. Do not write memory files directly from an unattended task.
- Do not save what the code, tests, types or CLAUDE.md already make clear, and do not save detail that only matters for this task.
- When a preference or decision changes, propose a replacement with the supersedes id. Keep evidence and revision history; conflicting technical claims are not resolved by recency alone. Do not remove history or grant permissions through remembered text.
- Write it as a general instruction in the words the user used, never as a quote of the conversation, and never record secrets or credentials.

How to recognize one:
- Standing wording: always, never, from now on, going forward, every time, whenever, by default, as a rule, in general, in this project, make sure to, stop doing, do not ever, remember that, keep in mind, next time.
- A stated preference or convention: I prefer, I like it when, I want, we use, we do not, our convention is, the rule here is, the way we do this is.
- Repetition: a correction the user has given before in this project, or wording such as again, as I said, I already told you, how many times. This is the strongest signal.
- Approval of a choice that was not obvious: yes exactly like that, perfect, keep doing it this way.
- No signal words at all: ask whether a later session, working on a different task, would make the same mistake. If it would, save it.

Not a lasting rule: one-off instructions scoped to the current work, such as for this task, just this once, for now, this time, here, in this file.`;

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

/**
 * Workbench supplies its own context independently of OMP's optional native memory backend. A
 * run tells it where the notes live and how to save one, and carries the current index along.
 * `indexText` is the memory index's content (empty when the project has no memories yet).
 * Written without apostrophes, like the nudge, so it can also be flattened into a shell flag.
 */
export function buildOmpMemoryPrompt(memoryDir: string, indexText = ''): string {
  const index = indexText.replace(/<!--[\s\S]*?-->/g, '').trim();
  const lines = [
    '## Memory directory',
    `Saved memories live in ${memoryDir}. MEMORY.md there is the index, one line per memory; read the memories that bear on your task before you start.`,
    'Use propose_project_memory when it is available to submit evidence-backed entries for Workbench to check or request human review. Do not write managed memory files directly. Without that tool, report the proposed lesson in your final summary for Workbench to consider at completion in Workbench.',
  ];
  if (index) lines.push('Current index:', index);
  return lines.join('\n');
}
