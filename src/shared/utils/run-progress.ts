/**
 * Live progress of a one-shot model run (Break into tasks): what the model is doing right now,
 * rolled up from the OMP stream (sizes of text, thinking and tool-call deltas, and the tools it
 * calls). Pure, with the clock passed in, so it can be tested.
 */

export type RunProgressStage = 'reading' | 'writing' | 'thinking';

export interface RunProgress {
  stage: RunProgressStage;
  /** Relative path (or pattern) of the last Read, Grep or Glob target */
  file?: string;
  /** Output size so far in tokens (characters / 4, text + thinking + tool calls) */
  tokens: number;
  elapsedMs: number;
  /** The model that runs, when known */
  model?: string;
}

/** At most one progress event per this many milliseconds */
export const RUN_PROGRESS_INTERVAL_MS = 1000;

const FILE_TOOLS = new Set(['read', 'grep', 'glob']);

/** Path of a tool call's target relative to the working directory; undefined when it names none */
export function toolTarget(name: string, input: unknown, cwd?: string): string | undefined {
  if (!FILE_TOOLS.has(name.toLowerCase()) || !input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const raw = [i.file_path, i.path, i.pattern].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (!raw) return undefined;
  let target = raw.replace(/\\/g, '/');
  const root = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  if (root && target.startsWith(`${root}/`)) target = target.slice(root.length + 1);
  return target;
}

export class RunProgressTracker {
  private chars = 0;
  private stage: RunProgressStage = 'thinking';
  private file: string | undefined;
  private lastEmit = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly startedAt: number,
    private model?: string,
    private readonly cwd?: string
  ) {}

  setModel(model: string | undefined): void {
    if (model) this.model = model;
  }

  /** A streamed delta of `chars` characters: text and tool-call deltas are writing, thinking is thinking */
  delta(kind: 'text' | 'thinking' | 'toolcall', chars: number): void {
    this.chars += chars;
    this.stage = kind === 'thinking' ? 'thinking' : 'writing';
  }

  /** The model called a tool */
  tool(name: string, input: unknown): void {
    const target = toolTarget(name, input, this.cwd);
    if (target) {
      this.file = target;
      this.stage = 'reading';
    }
  }

  snapshot(now: number): RunProgress {
    return {
      stage: this.stage,
      ...(this.file ? { file: this.file } : {}),
      tokens: Math.round(this.chars / 4),
      elapsedMs: Math.max(0, now - this.startedAt),
      ...(this.model ? { model: this.model } : {}),
    };
  }

  /** The snapshot to send now, or null while the last one is younger than the interval */
  next(now: number, force = false): RunProgress | null {
    if (!force && now - this.lastEmit < RUN_PROGRESS_INTERVAL_MS) return null;
    this.lastEmit = now;
    return this.snapshot(now);
  }
}
