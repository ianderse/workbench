import { describe, expect, it } from 'vitest';
import { createOmpTranslator, isOmpNotice, isOmpTodos, normalizeToolInput } from '../omp-translate';
import type { ClaudeResultMessage, ClaudeStreamMessage } from '../../claude-code/stream-types';

const usage = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });

function run(events: unknown[], options = {}) {
  const translator = createOmpTranslator(options);
  const out: ClaudeStreamMessage[] = [];
  for (const event of events) out.push(...translator.translate(event));
  return { translator, out };
}

const session = { type: 'session', version: 3, id: 'sess-1', cwd: '/work' };

describe('omp translator', () => {
  it('translates a run with a tool call, a tool result and a final answer', () => {
    const { out } = run([
      session,
      { type: 'agent_start' },
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      {
        type: 'message_end',
        message: {
          role: 'assistant', provider: 'ollama', model: 'qwen', stopReason: 'toolUse', usage: usage(0.5),
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Editing' },
            { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
          ],
        },
      },
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', result: {}, isError: false },
      { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], isError: false } },
      { type: 'message_end', message: { role: 'assistant', provider: 'ollama', model: 'qwen', stopReason: 'stop', usage: usage(0.25), content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'agent_end', messages: [] },
    ]);

    expect(out[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/work' });
    const assistant = out[1] as { type: string; message: { content: Array<Record<string, unknown>>; model?: string }; session_id: string };
    expect(assistant.type).toBe('assistant');
    expect(assistant.session_id).toBe('sess-1');
    expect(assistant.message.model).toBe('ollama/qwen');
    expect(assistant.message.content[0]).toEqual({ type: 'thinking', thinking: 'hmm' });
    expect(assistant.message.content[2]).toEqual({
      type: 'tool_use',
      id: 'call-1',
      name: 'Edit',
      input: { path: 'src/a.ts', old_string: 'a', new_string: 'b', file_path: 'src/a.ts' },
    });
    expect(out[2]).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false }] },
    });
    const result = out[out.length - 1] as ClaudeResultMessage;
    expect(result).toMatchObject({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sess-1', num_turns: 2, total_cost_usd: 0.75 });
  });

  it('reports a failed run as an error result and puts the error on the assistant message', () => {
    const failed = { role: 'assistant', content: [], model: 'gpt', stopReason: 'error', errorMessage: 'credit_balance_exhausted', usage: usage(0) };
    const { out } = run([
      session,
      { type: 'message_end', message: failed },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'x' },
      { type: 'agent_end', messages: [failed] },
    ]);
    expect(out[1]).toMatchObject({ type: 'assistant', error: 'credit_balance_exhausted' });
    expect(out[2]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['credit_balance_exhausted'],
    });
  });

  it('maps retries to api_retry', () => {
    const { out } = run([{ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 1500, errorMessage: 'overloaded' }]);
    expect(out).toEqual([{ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 1500, error: 'overloaded' }]);
  });

  it('synthesizes a result when the process ends without agent_end', () => {
    const { translator } = run([session]);
    const result = translator.finalize({ exitCode: 1, stderr: 'boom\nmodel not found' });
    expect(result).toMatchObject({ subtype: 'error_during_execution', is_error: true, errors: ['boom model not found'], session_id: 'sess-1' });
    expect(translator.finalize({ exitCode: 1 })).toBeUndefined();
  });

  it('does not duplicate the result after agent_end', () => {
    const { translator } = run([session, { type: 'agent_end', messages: [] }]);
    expect(translator.finalize({ exitCode: 0 })).toBeUndefined();
  });

  it('ignores unknown and malformed events', () => {
    const { out } = run([null, 'x', 42, { type: 'turn_start' }, { type: 'thinking_level_changed' }, { type: 'message_end' }, { type: 'message_end', message: { role: 'toolResult' } }]);
    expect(out).toHaveLength(1); // the tool result without ids still becomes a (tolerant) user message
    expect(out[0]).toMatchObject({ type: 'user' });
  });

  it('mirrors the todo list', () => {
    const { out } = run([{
      type: 'message_end',
      message: {
        role: 'toolResult', toolCallId: 't', toolName: 'todo', content: [{ type: 'text', text: 'ok' }],
        details: { op: 'init', phases: [{ name: 'p', tasks: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'abandoned' }, { content: 'd', status: 'blocked' }] }] },
      },
    }]);
    const todos = out.find(isOmpTodos);
    expect(todos?.todos).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'd', status: 'pending' },
    ]);
  });

  it('emits text deltas only when asked', () => {
    const event = { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'He' } };
    expect(run([event]).out).toEqual([]);
    expect(run([event], { emitDeltas: true }).out).toEqual([{ type: 'omp_text_delta', text: 'He' }]);
  });

  it('tracks model errors and announces a switch to a fallback model', () => {
    const failed = (model: string, errorMessage: string) => ({
      type: 'message_end',
      message: { role: 'assistant', provider: 'p', model, content: [], stopReason: 'error', errorMessage },
    });
    const { translator, out } = run([
      failed('local', 'stream stalled'),
      { type: 'model_change', model: 'openai-codex/luna', role: 'fallback' },
      failed('luna', 'usage_limit_reached'),
      { type: 'agent_end', messages: [] },
    ]);
    const notice = out.find(isOmpNotice);
    expect(notice?.text).toBe('OMP switched to fallback model openai-codex/luna after: stream stalled');
    expect(translator.errors.map((e) => [e.text, e.fallback])).toEqual([['stream stalled', false], ['usage_limit_reached', true]]);
    const result = out.find((m) => m.type === 'result') as { omp_errors?: unknown[] };
    expect(result.omp_errors).toHaveLength(2);
  });

  it('emits progress sizes for text, thinking and tool-call deltas when asked', () => {
    const update = (type: string) => ({ type: 'message_update', assistantMessageEvent: { type, delta: 'abc' } });
    expect(run([update('text_delta')]).out).toEqual([]);
    expect(run([update('thinking_delta')], { emitProgress: true }).out).toEqual([{ type: 'system', subtype: 'omp_progress', kind: 'thinking', chars: 3 }]);
    expect(run([update('toolcall_delta')], { emitProgress: true }).out).toEqual([{ type: 'system', subtype: 'omp_progress', kind: 'toolcall', chars: 3 }]);
    expect(run([update('text_delta')], { emitProgress: true, emitDeltas: true }).out).toHaveLength(2);
  });
});

describe('normalizeToolInput', () => {
  it('copies path to file_path and strips read selectors', () => {
    expect(normalizeToolInput('Read', { path: 'a.ts:10-20' }).file_path).toBe('a.ts');
    expect(normalizeToolInput('Write', { path: 'a.ts', content: 'x' }).file_path).toBe('a.ts');
  });

  it('keeps an existing file_path', () => {
    expect(normalizeToolInput('Edit', { path: 'a', file_path: 'b' }).file_path).toBe('b');
  });

  it('finds the files of a patch-style edit', () => {
    const input = normalizeToolInput('Edit', { input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n*** End Patch' });
    expect(input.file_path).toBe('src/a.ts');
    expect(input.file_paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('finds the files of a hashline edit (omp 18 default)', () => {
    const input = normalizeToolInput('Edit', { input: '[src/a.py#9CE3]\nPUT 1:\n+hello = 2\n[src/b.py#C27A]\nPUT 3:\n+x = 1' });
    expect(input.file_path).toBe('src/a.py');
    expect(input.file_paths).toEqual(['src/a.py', 'src/b.py']);
  });
});

describe('omp notices and advisor notes', () => {
  // Observed live (omp 18.11.0, advisor quota exhausted)
  const quotaNotice = { type: 'notice', level: 'warning', message: 'Advisor "default" quota exhausted \u2014 pausing until reset.', source: 'advisor' };
  // Shape from the advisor runtime in the binary: a custom message with `details.notes`
  const advisorCard = {
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'advisor',
      display: true,
      attribution: 'agent',
      content: 'BLOCKER the query is built with string concatenation',
      details: { notes: [
        { severity: 'blocker', note: 'The query is built with string concatenation' },
        { severity: 'concern', advisor: 'security', note: 'Hardcoded password' },
        { note: 'Looks fine otherwise' },
      ] },
    },
  };

  it('turns a notice event into an omp_notice message', () => {
    const out = createOmpTranslator().translate(quotaNotice);
    expect(out).toHaveLength(1);
    expect(isOmpNotice(out[0])).toBe(true);
    expect(out[0]).toMatchObject({ type: 'system', subtype: 'omp_notice', level: 'warning', source: 'advisor', text: expect.stringContaining('quota exhausted') });
  });

  it('defaults notice fields and ignores empty notices', () => {
    const t = createOmpTranslator();
    expect(t.translate({ type: 'notice', message: 'hello' })[0]).toMatchObject({ level: 'info', source: 'omp', text: 'hello' });
    expect(t.translate({ type: 'notice', message: '  ' })).toEqual([]);
  });

  it('turns each advisor note into a notice with its severity and advisor name', () => {
    const out = createOmpTranslator().translate(advisorCard);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ subtype: 'omp_notice', source: 'advisor', level: 'error', severity: 'blocker', text: 'The query is built with string concatenation' });
    expect(out[1]).toMatchObject({ level: 'warning', severity: 'concern', advisor: 'security' });
    expect(out[2]).toMatchObject({ level: 'info', text: 'Looks fine otherwise' });
    expect((out[2] as { advisor?: string }).advisor).toBeUndefined();
  });

  it('falls back to the card text and ignores advisor_yielded bookkeeping events', () => {
    const t = createOmpTranslator();
    const out = t.translate({ type: 'message_end', message: { role: 'custom', customType: 'advisor', content: 'plain text' } });
    expect(out).toMatchObject([{ subtype: 'omp_notice', source: 'advisor', text: 'plain text' }]);
    expect(t.translate({ type: 'advisor_yielded' })).toEqual([]);
    expect(t.translate({ type: 'advisor_cost_changed' })).toEqual([]);
  });

  it('never lets advisor notes become the answer', () => {
    const t = createOmpTranslator();
    t.translate({ type: 'session', id: 's1' });
    t.translate({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '{"ok":true}' }] } });
    t.translate(advisorCard);
    expect(t.lastText).toBe('{"ok":true}');
    const result = t.translate({ type: 'agent_end', messages: [] }).find((m) => m.type === 'result') as ClaudeResultMessage;
    expect(result.result).toBe('{"ok":true}');
    expect(result.is_error).toBe(false);
  });
});
