/**
 * When each agent window's terminal was last written to (the user's keys and the commands
 * Workbench sends itself).
 *
 * Live agent uses it to tell which window a Claude Code session belongs to: Claude Code runs its
 * sessions in one daemon shared by the whole machine, which keeps the environment of whichever
 * window happened to start it, so the terminal id every session's hooks report is that window's
 * (see live-agent-relay.ts).
 */

/** Last write per terminal id, newest last */
const lastWrite = new Map<string, number>();

/** How many terminals are remembered (older ones are dropped) */
const MAX_TERMINALS = 100;

/** Something was written to the window's terminal */
export function noteTerminalWrite(terminalId: string): void {
  lastWrite.delete(terminalId);
  lastWrite.set(terminalId, Date.now());
  if (lastWrite.size > MAX_TERMINALS) lastWrite.delete(lastWrite.keys().next().value!);
}

/** When the window's terminal was last written to (0: not since the app started) */
export function getTerminalWriteTime(terminalId: string): number {
  return lastWrite.get(terminalId) ?? 0;
}
