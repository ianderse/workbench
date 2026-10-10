import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ClaudeProcessOptions } from '../process';
import type { ClaudeStreamMessage } from '../stream-types';
import type { TaskTriage } from '../../../shared/types/claude-code';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS } from '../../../shared/types/claude-code';

vi.mock('../env', () => ({
  resolveClaudeEnv: vi.fn(async (options?: { extraEnv?: Record<string, string> }) => ({
    command: 'claude',
    env: { ...(options?.extraEnv ?? {}) },
  })),
}));

/** Scripted Claude Code runs: one entry per spawned process */
type Script = { messages: ClaudeStreamMessage[] };
const scripts: Script[] = [];
const spawned: ClaudeProcessOptions[] = [];

vi.mock('../process', () => ({
  startClaudeProcess: vi.fn((options: ClaudeProcessOptions) => {
    spawned.push(options);
    const script = scripts.shift() ?? { messages: [] };
    let result: ClaudeStreamMessage | undefined;
    for (const message of script.messages) {
      if (message.type === 'result') result = message;
      options.onMessage?.(message);
    }
    return {
      child: {},
      stop: vi.fn(),
      done: Promise.resolve({ exitCode: 0, signal: null, result, stderr: '', aborted: false, timedOut: false }),
    };
  }),
}));

const triageMock = vi.fn();
vi.mock('../triage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../triage')>();
  return { ...actual, triageTask: (...args: unknown[]) => triageMock(...args) };
});

import { ClaudeTaskRun, loadClaudeRunInfo } from '../task-runner';

function result(sessionId: string, fields: Record<string, unknown> = {}): ClaudeStreamMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: 'Done',
    total_cost_usd: 0.1,
    num_turns: 3,
    duration_ms: 1000,
    ...fields,
  } as ClaudeStreamMessage;
}

function triage(overrides: Partial<TaskTriage> = {}): TaskTriage {
  return {
    model: 'sonnet',
    effort: 'medium',
    needsPlan: false,
    scope: 'small',
    title: 'Add subtract',
    reasoning: 'Small change',
    verification: ['npm test'],
    source: 'auto',
    ...overrides,
  };
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('ClaudeTaskRun', () => {
  let specDir: string;
  let worktree: string;

  beforeEach(() => {
    scripts.length = 0;
    spawned.length = 0;
    triageMock.mockReset();
    specDir = mkdtempSync(path.join(tmpdir(), 'spec-'));
    worktree = mkdtempSync(path.join(tmpdir(), 'wt-'));
  });

  afterEach(() => {
    rmSync(specDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  function makeRun(overrides: Record<string, unknown> = {}, callbacks = {}) {
    return new ClaudeTaskRun({
      taskId: 't1',
      specId: '001-task',
      specDir,
      worktreePath: worktree,
      branch: 'auto-claude/001-task',
      baseBranch: 'main',
      title: 'Task',
      description: 'Add a subtract function',
      attachments: [],
      connectorIds: [],
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS },
      mode: 'start',
      ...overrides,
    }, callbacks);
  }

  it('triages, plans, implements and validates in one resumed session', async () => {
    triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }), costUsd: 0.01 });
    scripts.push(
      { messages: [
        { type: 'system', subtype: 'init', session_id: 's1', tools: ['Read'], skills: ['code-review'], agents: ['Explore'], mcp_servers: [{ name: 'context7', status: 'connected' }], plugins: [] } as ClaudeStreamMessage,
        result('s1', { structured_output: { plan: '# Plan\n- step' }, total_cost_usd: 0.2 }),
      ] },
      { messages: [result('s1', { total_cost_usd: 0.5, result: 'Implemented' })] },
      { messages: [result('s1', {
        total_cost_usd: 0.6,
        structured_output: { status: 'passed', summary: 'All good', checks: [{ name: 'tests', command: 'npm test', passed: true }], findings: [] },
      })] },
    );
    const events: string[] = [];
    const outcome = await makeRun({}, { onTaskEvent: (type: string) => events.push(type) }).run();

    expect(outcome.status).toBe('completed');
    expect(events).toEqual(['CODING_STARTED', 'QA_STARTED', 'QA_PASSED']);

    // Plan runs in plan mode on a new session, later steps resume it with permissions bypassed
    const [plan, implement, validate] = spawned.map((s) => s.args);
    expect(argValue(plan, '--permission-mode')).toBe('plan');
    expect(argValue(plan, '--model')).toBe('opus');
    expect(plan).toContain('--session-id');
    expect(plan).toContain('--json-schema');
    expect(implement).toContain('--dangerously-skip-permissions');
    // The session id reported by Claude Code is the one later steps resume
    expect(argValue(implement, '--resume')).toBe('s1');
    expect(argValue(implement, '--model')).toBe('sonnet');
    expect(argValue(implement, '--effort')).toBe('medium');
    expect(validate).toContain('--json-schema');
    expect(spawned[1].env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');

    const info = loadClaudeRunInfo(specDir)!;
    expect(info.plan).toBe('# Plan\n- step');
    expect(existsSync(path.join(specDir, 'plan.md'))).toBe(true);
    expect(info.validation?.status).toBe('passed');
    expect(info.init?.skills).toEqual(['code-review']);
    expect(info.phases.map((p) => p.name)).toEqual(['triage', 'plan', 'implement', 'validate']);
    // Session cost is cumulative: phases get the difference, total adds triage
    expect(info.phases.map((p) => p.costUsd)).toEqual([0.01, 0.2, 0.3, expect.closeTo(0.1, 5)]);
    expect(info.totalCostUsd).toBeCloseTo(0.61, 5);
    expect(existsSync(path.join(specDir, 'task_logs.json'))).toBe(true);
  });

  it('skips planning and validation when not needed', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s2')] });
    const run = makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } });
    const outcome = await run.run();
    expect(outcome.status).toBe('completed');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('--dangerously-skip-permissions');
    expect(spawned[0].args).not.toContain('--resume');
  });

  it('uses fixed model and effort without a triage run', async () => {
    scripts.push({ messages: [result('s3')] });
    await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, triage: 'fixed', fixedModel: 'opus', fixedEffort: 'high', validation: false } }).run();
    expect(triageMock).not.toHaveBeenCalled();
    expect(argValue(spawned[0].args, '--model')).toBe('opus');
    expect(argValue(spawned[0].args, '--effort')).toBe('high');
    expect(loadClaudeRunInfo(specDir)?.triage?.source).toBe('fixed');
  });

  it('falls back to the default model when triage fails', async () => {
    triageMock.mockRejectedValue(new Error('boom'));
    scripts.push({ messages: [result('s4')] });
    const outcome = await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(outcome.status).toBe('completed');
    expect(loadClaudeRunInfo(specDir)?.triage?.source).toBe('fallback');
  });

  it('puts the task on hold when Claude reports a usage limit', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s5', { result: "You've hit your session limit · resets 8:30pm (UTC)" })] });
    const events: Array<[string, Record<string, unknown>]> = [];
    const outcome = await makeRun({}, { onTaskEvent: (type: string, payload: Record<string, unknown>) => events.push([type, payload]) }).run();
    expect(outcome.status).toBe('rate_limited');
    const hold = events.find(([type]) => type === 'RATE_LIMIT_HOLD');
    expect(hold?.[1].resetAt).toEqual(expect.any(String));
    expect(hold?.[1].phase).toBe('coding');
  });

  it('continues an interrupted implementation in the same session', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s6', { is_error: true, subtype: 'error_during_execution', errors: ['crash'] })] });
    const first = await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(first.status).toBe('failed');

    scripts.push({ messages: [result('s6')] });
    const second = await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(second.status).toBe('completed');
    expect(triageMock).toHaveBeenCalledTimes(1);
    expect(spawned[1].args).toContain('--resume');
    const text = (spawned[1].input as Array<{ type: string; text?: string }>)[0].text;
    expect(text).toMatch(/Continue the task/);
  });

  it('applies reviewer feedback in the same session and validates again', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push(
      { messages: [result('s7')] },
      { messages: [result('s7', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
    );
    await makeRun().run();

    scripts.push(
      { messages: [result('s7')] },
      { messages: [result('s7', { structured_output: { status: 'failed', summary: 'still broken', checks: [], findings: [{ severity: 'major', description: 'bug', fixed: false }] } })] },
    );
    const events: string[] = [];
    const outcome = await makeRun({ mode: 'revise', feedback: 'Rename it' }, { onTaskEvent: (type: string) => events.push(type) }).run();
    expect(outcome.status).toBe('completed');
    expect(events).toContain('QA_FAILED');
    const reviseInput = (spawned[2].input as Array<{ text?: string }>)[0].text;
    expect(reviseInput).toContain('Rename it');
    expect(spawned[2].args).toContain('--resume');
  });

  it("mirrors Claude Code's task list as subtasks", async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [
      { type: 'assistant', session_id: 's8', parent_tool_use_id: null, message: { content: [
        { type: 'tool_use', id: 'tu1', name: 'TaskCreate', input: { subject: 'Write code', description: 'd' } },
      ] } } as ClaudeStreamMessage,
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Task #1 created successfully' }] } } as ClaudeStreamMessage,
      { type: 'assistant', session_id: 's8', parent_tool_use_id: null, message: { content: [
        { type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      ] } } as ClaudeStreamMessage,
      result('s8'),
    ] });
    const updates: Array<Array<{ id: string; status: string }>> = [];
    await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }, { onSubtasks: (s: Array<{ id: string; status: string }>) => updates.push(s) }).run();
    expect(updates.at(-1)).toEqual([expect.objectContaining({ id: '1', title: 'Write code', status: 'completed' })]);
    const log = JSON.parse(readFileSync(path.join(specDir, 'task_logs.json'), 'utf-8'));
    expect(log.phases.coding.entries.some((e: { tool_name?: string }) => e.tool_name === 'TaskCreate')).toBe(true);
  });
});
