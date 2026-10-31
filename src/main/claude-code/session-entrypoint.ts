/**
 * How a Claude Code session was run
 * =================================
 *
 * Every transcript record that carries a `cwd` also carries an `entrypoint`: `cli` for an interactive
 * session (an agent window, a terminal), `sdk-cli` for a headless `claude -p` run (the Claude page's
 * chats, task runs, one-shot calls) and `sdk-ts` / `sdk-py` for the Agent SDKs. Headless sessions
 * share the project's transcript folder with the agent windows' sessions but are never one of them.
 * Older transcripts have no `entrypoint` at all; they count as interactive.
 *
 * Pure text helpers, so the Live agent relay worker can use them too.
 */

/** A record's `entrypoint` field, matched in raw text (quotes inside message text are escaped, so
 *  this only matches the field itself) */
const ENTRYPOINT_FIELD = /"entrypoint":"((?:[^"\\]|\\.)*)"/;

/** The first `entrypoint` a piece of transcript text records, if any */
export function transcriptEntrypoint(text: string): string | undefined {
  const match = ENTRYPOINT_FIELD.exec(text);
  return match ? match[1] : undefined;
}

/** Whether an entrypoint is a headless (print mode or SDK) run; a missing one is interactive */
export function isHeadlessEntrypoint(entrypoint: string | undefined): boolean {
  return typeof entrypoint === 'string' && entrypoint.startsWith('sdk-');
}
