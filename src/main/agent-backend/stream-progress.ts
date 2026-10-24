/**
 * Progress of a long streaming reply
 * ==================================
 *
 * A local model can write one reply for an hour; without a sign of life the task log looks hung.
 * The accumulator counts streamed characters (text, thinking and tool-call arguments) and says
 * when a "Model is writing..." line is due: at most once per interval per reply. Pure (the clock
 * is passed in) so it can be tested.
 */

export const STREAM_PROGRESS_INTERVAL_MS = 60_000;

/** Rough token count of streamed text (about four characters per token) */
export function estimateTokens(chars: number): number {
  return Math.max(Math.round(chars / 4), 0);
}

export class StreamProgress {
  private chars = 0;
  private startedAt: number | undefined;
  private lastReportAt: number | undefined;

  constructor(private readonly intervalMs = STREAM_PROGRESS_INTERVAL_MS) {}

  /** Count a chunk; returns the log line when one is due, else undefined */
  add(chars: number, now: number): string | undefined {
    if (this.startedAt === undefined) {
      this.startedAt = now;
      this.lastReportAt = now;
    }
    this.chars += chars;
    if (now - (this.lastReportAt ?? now) < this.intervalMs) return undefined;
    this.lastReportAt = now;
    const minutes = Math.max(Math.round((now - this.startedAt) / 60_000), 1);
    return `Model is writing… ~${estimateTokens(this.chars).toLocaleString('en-US')} tokens so far (${minutes} min into this reply)`;
  }

  /** A reply finished (or a new run started): the next chunk starts a fresh count */
  reset(): void {
    this.chars = 0;
    this.startedAt = undefined;
    this.lastReportAt = undefined;
  }
}
