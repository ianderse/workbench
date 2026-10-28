import { describe, expect, it } from 'vitest';
import { ompEventDiagnostic, ompLaunchDiagnostic, promptComponentBytes, promptSize } from '../omp-prompt-diagnostics';

describe('OMP size-only diagnostics', () => {
  it('measures UTF-8 bytes separately from JavaScript character length without retaining bodies', () => {
    expect(promptSize('A🙂')).toEqual({ chars: 3, bytes: 5 });
    const diagnostic = ompLaunchDiagnostic({
      args: ['--mode', 'rpc', '--resume', 'secret-session', '--tools', 'read,bash'],
      input: 'private instruction🙂', systemPrompt: 'private system', appendSystemPrompt: 'private append',
      label: 'task-1 implement\nforged log', job: 'implement', purpose: 'run',
      components: { parallelTasks: 12, memoryPacket: 9, 'private section body': 700 },
      attachmentCount: 1, attachmentBytes: 42,
    });
    expect(diagnostic).toMatchObject({
      coverage: 'workbench-launch-only', transport: 'rpc', resumed: true, purpose: 'run',
      label: 'task-1 implement forged log', tools: 'selected', selectedToolCount: 2,
      newInstruction: { chars: 21, bytes: 23 }, attachmentCount: 1, attachmentBytes: 42,
      componentBytes: { parallelTasks: 12, memoryPacket: 9 },
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    expect(JSON.stringify(diagnostic)).not.toContain('secret-session');
  });

  it('bounds identifiers and keeps only finite nonnegative counts under known component names', () => {
    expect(promptComponentBytes({ parallelTasks: NaN, memoryPacket: Infinity, graphify: -1, briefing: 2 })).toEqual({ briefing: 2 });
    expect(ompLaunchDiagnostic({ label: 'a'.repeat(1000), args: ['-p', '--mode', 'json', '--no-tools'], input: '', attachmentCount: 0, attachmentBytes: 0, purpose: 'json-repair' })).toMatchObject({
      label: 'a'.repeat(160), resumed: false, tools: 'none', transport: 'print', purpose: 'json-repair',
    });
  });

  it('reports each assistant reply independently with cache counters separate from input', () => {
    const reply = (input: number) => ({ type: 'message_end', message: {
      role: 'assistant', provider: 'local', model: 'qwen', stopReason: 'stop',
      usage: { input, output: 4, cacheRead: 50, cacheWrite: 7, cost: { secret: 'private' } },
      content: [{ type: 'text', text: 'private response' }], errorMessage: 'private failure',
    } });
    expect(ompEventDiagnostic(reply(120))).toEqual({ event: 'reply-usage', coverage: 'omp-assistant-message', provider: 'local', model: 'qwen', failed: false, input: 120, output: 4, cacheRead: 50, cacheWrite: 7 });
    expect(ompEventDiagnostic(reply(200))?.input).toBe(200);
    expect(JSON.stringify(ompEventDiagnostic(reply(1)))).not.toContain('private');
    expect(ompEventDiagnostic({ type: 'message_end', message: { role: 'toolResult', content: 'private result', usage: { input: 100 } } })).toBeUndefined();
    expect(ompEventDiagnostic({ type: 'message_end', message: { role: 'assistant' } })).toBeUndefined();
  });

  it('logs compaction boundaries without summaries, arbitrary reasons or errors', () => {
    expect(ompEventDiagnostic({ type: 'auto_compaction_start', reason: 'threshold', summary: 'private summary' })).toEqual({ event: 'auto_compaction_start', reason: 'threshold' });
    expect(ompEventDiagnostic({ type: 'auto_compaction_end', aborted: true, errorMessage: 'private failure', result: { summary: 'private summary' } })).toEqual({ event: 'auto_compaction_end', aborted: true });
    expect(ompEventDiagnostic({ type: 'auto_compaction_start', reason: 'private reason' })).toEqual({ event: 'auto_compaction_start' });
  });
});
