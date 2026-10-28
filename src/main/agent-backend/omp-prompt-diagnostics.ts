/** Size-only diagnostics. Never include prompt, tool result, attachment, or provider payload bodies. */
export function promptSize(text: string | undefined): { chars: number; bytes: number } {
  return { chars: text?.length ?? 0, bytes: Buffer.byteLength(text ?? '', 'utf8') };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[\r\n\t\x00-\x1f]/g, ' ').slice(0, 160) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Only known section names pass through; a caller cannot accidentally log prompt text as a key. */
export function promptComponentBytes(components: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ['standingInstructions', 'graphify', 'projectMemoryInstructions', 'briefing', 'parallelTasks', 'messaging', 'memoryPacket', 'planningRule', 'foregroundRule']) {
    const bytes = count(components?.[key]);
    if (bytes !== undefined) out[key] = bytes;
  }
  return out;
}

export interface OmpLaunchDiagnosticOptions {
  label: string;
  job?: string;
  args: readonly string[];
  input: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  components?: Record<string, number>;
  attachmentCount: number;
  attachmentBytes: number;
  purpose: 'run' | 'json-repair';
}

/** Workbench's contribution at launch, before OMP loads context, tools, extensions and history. */
export function ompLaunchDiagnostic(options: OmpLaunchDiagnosticOptions) {
  const toolsIndex = options.args.lastIndexOf('--tools');
  return {
    event: 'launch',
    coverage: 'workbench-launch-only',
    label: identifier(options.label),
    job: identifier(options.job),
    purpose: options.purpose,
    transport: options.args[options.args.lastIndexOf('--mode') + 1] === 'rpc' ? 'rpc' : 'print',
    resumed: options.args.includes('--resume'),
    newInstruction: promptSize(options.input),
    systemPrompt: promptSize(options.systemPrompt),
    appendSystemPrompt: promptSize(options.appendSystemPrompt),
    componentBytes: promptComponentBytes(options.components),
    attachmentCount: options.attachmentCount,
    attachmentBytes: options.attachmentBytes,
    tools: options.args.includes('--no-tools') ? 'none' : toolsIndex >= 0 ? 'selected' : 'default',
    ...(toolsIndex >= 0 ? { selectedToolCount: options.args[toolsIndex + 1]?.split(',').length ?? 0 } : {}),
  };
}

/** Per-reply provider usage from OMP, not accumulated run usage or a serialized payload measurement.
 * Auxiliary calls (e.g. a compaction model) may not emit assistant messages on this stream.
 */
export function ompEventDiagnostic(value: unknown): Record<string, unknown> | undefined {
  const event = record(value);
  if (!event) return undefined;
  if (event.type === 'auto_compaction_start' || event.type === 'auto_compaction_end') {
    return {
      event: event.type,
      ...(event.reason === 'threshold' || event.reason === 'overflow' ? { reason: event.reason } : {}),
      ...(typeof event.aborted === 'boolean' ? { aborted: event.aborted } : {}),
    };
  }
  const message = record(event.message);
  const usage = record(message?.usage);
  if (event.type !== 'message_end' || message?.role !== 'assistant' || !usage) return undefined;
  return {
    event: 'reply-usage',
    coverage: 'omp-assistant-message',
    provider: identifier(message.provider),
    model: identifier(message.model),
    failed: message.stopReason === 'error',
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    ...(count(usage.contextTokens) !== undefined ? { reportedContextTokens: count(usage.contextTokens) } : {}),
  };
}
