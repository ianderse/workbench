import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
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

/** Claude Code inside WSL: the session sees the worktree as /mnt/wt (mapped back to the real one) */
const runtimeRef = vi.hoisted(() => ({ wsl: false, worktree: '' }));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  getWslInfo: () => (runtimeRef.wsl ? { distro: 'Ubuntu', home: '/home/me', loginPath: '/usr/bin', mountRoot: '/mnt/', tools: {} } : null),
  toHostPath: (p: string) => (runtimeRef.wsl ? p.replace(/^\/mnt\/wt(?=\/|$)/, runtimeRef.worktree) : p),
  toRuntimePath: (p: string) => (runtimeRef.wsl ? `/mnt/host${p}` : p),
}));

const triageMock = vi.fn();
vi.mock('../triage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../triage')>();
  return { ...actual, triageTask: (...args: unknown[]) => triageMock(...args) };
});

import { ClaudeTaskRun, loadClaudeRunInfo, ompSubagentGuidance } from '../task-runner';
import { ompSubagentsPerTask } from '../../../shared/types/agent-backend';
import { SELF_IMPROVE_NUDGE } from '../../self-improve/nudge';

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
    runtimeRef.wsl = false;
    runtimeRef.worktree = worktree;
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
      branch: 'workbench/001-task',
      baseBranch: 'main',
      title: 'Task',
      description: 'Add a subtract function',
      attachments: [],
      connectorIds: [],
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS },
      mode: 'start',
      backend: 'claude',
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


  it('has the verdict on disk when QA_PASSED fires, so listeners reading claude_run.json see it (auto-merge race)', async () => {
    scripts.push(
      { messages: [result('s1', { structured_output: { plan: '# Plan' }, total_cost_usd: 0 })] },
      { messages: [result('s1', { total_cost_usd: 0, result: 'Implemented' })] },
      { messages: [result('s1', {
        total_cost_usd: 0,
        structured_output: { status: 'passed', summary: 'All good', checks: [], findings: [] },
      })] },
    );
    let verdictOnDisk: string | undefined;
    await makeRun({}, {
      onTaskEvent: (type: string) => {
        if (type !== 'QA_PASSED') return;
        const onDisk = JSON.parse(readFileSync(path.join(specDir, 'claude_run.json'), 'utf-8'));
        verdictOnDisk = onDisk.reviewVerdict?.status;
      },
    }).run();
    expect(verdictOnDisk).toBe('passed');
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
    // An unknown-size task is planned first under the 'auto' policy
    scripts.push({ messages: [result('s4', { structured_output: { plan: '# Plan' } })] }, { messages: [result('s4')] });
    const outcome = await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(outcome.status).toBe('completed');
    const info = loadClaudeRunInfo(specDir);
    expect(info?.triage?.source).toBe('fallback');
    expect(info?.triage?.needsPlan).toBe(true);
    expect(info?.phases.map((p) => p.name)).toEqual(['triage', 'plan', 'implement']);
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
    const outcome = await makeRun({ mode: 'revise', feedback: 'Rename it', settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, aiReviewRounds: 1 } }, { onTaskEvent: (type: string) => events.push(type) }).run();
    expect(outcome.status).toBe('completed');
    expect(events).toContain('QA_FAILED');
    const reviseInput = (spawned[2].input as Array<{ text?: string }>)[0].text;
    expect(reviseInput).toContain('The reviewer requested changes:\n\n<feedback>\nRename it\n</feedback>\n\nApply them,');
    expect(spawned[2].args).toContain('--resume');
    // The change request is assessed first (triage), then applied with the model triage picked
    expect(triageMock).toHaveBeenCalledTimes(2);
    expect(triageMock.mock.calls[1][0].description).toContain('Rename it');
    expect(loadClaudeRunInfo(specDir)!.phases.slice(-3).map((p) => p.name)).toEqual(['triage', 'revise', 'validate']);
  });

  describe('AI review loop', () => {
    const failing = (s: string, findings: Array<Record<string, unknown>>, status = 'partial') =>
      ({ messages: [result(s, { structured_output: { status, summary: 'Needs work. The parser is wrong.', checks: [], findings } })] });
    const passing = (s: string) =>
      ({ messages: [result(s, { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] });
    const finding = (description: string, extra: Record<string, unknown> = {}) =>
      ({ severity: 'major', description, fixed: false, file: 'src/a.ts', line: 4, ...extra });

    it('sends the task back to fix open findings, then passes', async () => {
      triageMock.mockResolvedValue({ triage: triage() });
      scripts.push(
        { messages: [result('l1')] },
        failing('l1', [finding('Off by one')]),
        { messages: [result('l1', { result: 'Fixed' })] },
        passing('l1'),
      );
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const outcome = await makeRun({}, { onTaskEvent: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }) }).run();
      expect(outcome.status).toBe('completed');
      expect(events.map((e) => e.type)).toEqual(['CODING_STARTED', 'QA_STARTED', 'CODING_STARTED', 'QA_STARTED', 'QA_PASSED']);
      expect(events[1].payload).toEqual({ iteration: 1, maxIterations: 3 });
      expect(events[3].payload).toEqual({ iteration: 2, maxIterations: 3 });
      expect(events[4].payload).toMatchObject({ iteration: 2, maxIterations: 3 });
      const fixInput = (spawned[2].input as Array<{ text?: string }>)[0].text;
      expect(fixInput).toContain('Off by one');
      expect(fixInput).toContain('src/a.ts:4');
      expect(spawned[2].args).toContain('--resume');
      const info = loadClaudeRunInfo(specDir)!;
      expect(info.phases.map((p) => p.name)).toEqual(['triage', 'implement', 'validate', 'revise', 'validate']);
      expect(info.reviewRounds?.map((r) => [r.round, r.openFindings.length, r.fixedCount])).toEqual([[1, 1, 0], [2, 0, 1]]);
      expect(info.reviewVerdict).toEqual({ status: 'passed', rounds: 2, maxRounds: 3 });
    });

    it('fails with a summary when every round still has open findings', async () => {
      triageMock.mockResolvedValue({ triage: triage() });
      scripts.push(
        { messages: [result('l2')] },
        failing('l2', [finding('A'), finding('B', { line: 9 })]),
        { messages: [result('l2')] },
        failing('l2', [finding('A')]),
        { messages: [result('l2')] },
        failing('l2', [finding('A')], 'failed'),
      );
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      await makeRun({}, { onTaskEvent: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }) }).run();
      expect(spawned).toHaveLength(6);
      const last = events[events.length - 1];
      expect(last.type).toBe('QA_FAILED');
      expect(last.payload).toMatchObject({ iteration: 3, maxIterations: 3, issueCount: 1 });
      expect((last.payload.issues as string[]).join('\n')).toContain('major src/a.ts:4: A');
      const verdict = loadClaudeRunInfo(specDir)!.reviewVerdict!;
      expect(verdict.status).toBe('failed');
      expect(verdict.failure?.reason).toBe('Needs work. The parser is wrong.');
      expect(verdict.failure?.roundLines).toEqual([
        'Round 1: 2 blocker/major found, 2 still open',
        'Round 2: fixed 1, 1 still open',
        'Round 3: fixed 0, 1 still open',
      ]);
    });

    it('does not loop for minor-only findings', async () => {
      triageMock.mockResolvedValue({ triage: triage() });
      scripts.push({ messages: [result('l3')] }, failing('l3', [finding('Typo', { severity: 'minor' })]));
      const events: string[] = [];
      await makeRun({}, { onTaskEvent: (type: string) => events.push(type) }).run();
      expect(events).toEqual(['CODING_STARTED', 'QA_STARTED', 'QA_PASSED']);
      expect(spawned).toHaveLength(2);

    });

    it('keeps the single pass with one round', async () => {
      triageMock.mockResolvedValue({ triage: triage() });
      scripts.push({ messages: [result('l4')] }, failing('l4', [finding('Bug')]));
      const one: string[] = [];
      await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, aiReviewRounds: 1 } }, { onTaskEvent: (type: string) => one.push(type) }).run();
      // Single pass: a partial report passes as it did before the loop
      expect(one).toEqual(['CODING_STARTED', 'QA_STARTED', 'QA_PASSED']);
    });
  });

  it('points the revision at the images when the reviewer asked for the changes in screenshots alone', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    writeFileSync(path.join(specDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(specDir, 'shot2.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = (filename: string) => ({ path: path.join(specDir, filename), filename, mimeType: 'image/png' });
    const noValidation = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false };

    scripts.push({ messages: [result('s13')] });
    await makeRun({ mode: 'revise', feedback: '', feedbackAttachments: [image('shot.png')], settings: noValidation }).run();

    const input = spawned[0].input as Array<{ type: string; text?: string }>;
    expect(input[0].text).toContain('The reviewer requested changes:\n\nsee the attached image.\n\nApply them,');
    expect(input[0].text).not.toContain('<feedback>');
    // The image is on the same turn, so the sentence above has something to point at
    expect(input.map((block) => block.type)).toEqual(['text', 'image']);
    // Triage sizes the change from the same statement of it, not from a claim that there is none
    expect(triageMock.mock.calls[0][0].description).toContain('see the attached image.');
    expect(triageMock.mock.calls[0][0].attachmentNames).toEqual(['shot.png']);

    // Several screenshots are counted, so the model knows how many to look for
    scripts.push({ messages: [result('s13')] });
    await makeRun({ mode: 'revise', feedback: '  ', feedbackAttachments: [image('shot.png'), image('shot2.png')], settings: noValidation }).run();
    const resumed = spawned[1].input as Array<{ type: string; text?: string }>;
    expect(resumed[0].text).toContain('The reviewer requested changes:\n\nsee the 2 attached images.\n\nApply them,');
    expect(resumed.map((block) => block.type)).toEqual(['text', 'image', 'image']);
  });

  /**
   * The sentence that points at the images is written from the images the turn really carries, not
   * from what the reviewer picked: an attachment over the image limit is dropped while the request
   * is being built, and a request of one oversized screenshot and no text would otherwise read as
   * "see the attached image" above a turn carrying no image at all - and would skip the one wording
   * that is honest about it.
   */
  it('does not promise images that were too large to attach', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(path.join(specDir, 'small.png'), png);
    // Over MAX_IMAGE_BYTES (5 MB), the limit the run drops an image at
    writeFileSync(path.join(specDir, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const image = (filename: string) => ({ path: path.join(specDir, filename), filename, mimeType: 'image/png' });
    const noValidation = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false };

    scripts.push({ messages: [result('s15')] });
    await makeRun({ mode: 'revise', feedback: '', feedbackAttachments: [image('huge.png')], settings: noValidation }).run();

    const input = spawned[0].input as Array<{ type: string; text?: string }>;
    expect(input[0].text).toContain('The reviewer requested changes:\n\nno notes came with the request, so review the change against the task with fresh eyes');
    expect(input[0].text).not.toContain('attached image');
    expect(input.map((block) => block.type)).toEqual(['text']);

    // Only the images that survived are counted, so two attachments can still be "the attached image"
    scripts.push({ messages: [result('s15')] });
    await makeRun({
      mode: 'revise',
      feedback: '',
      feedbackAttachments: [image('huge.png'), image('small.png')],
      settings: noValidation,
    }).run();
    const resumed = spawned[1].input as Array<{ type: string; text?: string }>;
    expect(resumed[0].text).toContain('The reviewer requested changes:\n\nsee the attached image.\n\nApply them,');
    expect(resumed.map((block) => block.type)).toEqual(['text', 'image']);
  });

  /**
   * A run started over from "Request changes" introduces the same images from the same count, so
   * the oversized screenshot has to disappear from its notes as well.
   */
  it('leaves the images out of a restarted run\'s notes when none of them could be attached', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    writeFileSync(path.join(specDir, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const noValidation = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false };

    scripts.push({ messages: [result('s16')] });
    await makeRun({
      mode: 'start',
      feedback: '',
      feedbackAttachments: [{ path: path.join(specDir, 'huge.png'), filename: 'huge.png', mimeType: 'image/png' }],
      settings: noValidation,
    }).run();

    const input = spawned[0].input as Array<{ type: string; text?: string }>;
    expect(input[0].text).not.toContain('starting it over');
    expect(input[0].text).not.toContain('attached image');
    expect(input.map((block) => block.type)).toEqual(['text']);
  });

  it('asks for a fresh look when a change request arrives with neither notes nor images', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s14')] });
    await makeRun({ mode: 'revise', feedback: '', settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();

    const text = (spawned[0].input as Array<{ text?: string }>)[0].text!;
    expect(text).toContain('The reviewer requested changes:\n\nno notes came with the request, so review the change against the task with fresh eyes');
    expect(text).not.toContain('<feedback>');
    expect(triageMock.mock.calls[0][0].description).toContain('they left no notes with the request.');
  });

  it('tells a run started over what the discarded attempt got wrong', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push(
      { messages: [result('s8')] },
      { messages: [result('s8', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
    );
    const outcome = await makeRun({ mode: 'start', feedback: 'It edited the wrong module' }).run();
    expect(outcome.status).toBe('completed');

    // A fresh session (no --resume) that quotes the reviewer's notes, and triage sees them too
    const input = (spawned[0].input as Array<{ text?: string }>)[0].text;
    expect(input).toContain('starting it over');
    expect(input).toContain('It edited the wrong module');
    expect(spawned[0].args).not.toContain('--resume');
    expect(triageMock.mock.calls[0][0].description).toContain('It edited the wrong module');
  });

  it('resumes on the profile that holds the session and copies the transcript when the profile changes', async () => {
    const { resolveClaudeEnv } = await import('../env');
    const envMock = vi.mocked(resolveClaudeEnv);
    const dirA = path.join(worktree, 'config-a');
    const dirB = path.join(worktree, 'config-b');
    envMock.mockImplementation(async (options) => ({
      command: 'claude',
      env: { ...(options?.extraEnv ?? {}), CLAUDE_CONFIG_DIR: options?.profileId === 'b' ? dirB : dirA },
      profileId: options?.profileId ?? 'a',
    }));
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s9', { is_error: true, subtype: 'error_during_execution', errors: ['crash'] })] });
    await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(loadClaudeRunInfo(specDir)).toMatchObject({ profileId: 'a', configDir: dirA });

    // Without a forced profile the resume stays on profile a
    scripts.push({ messages: [result('s9', { is_error: true, subtype: 'error_during_execution', errors: ['crash'] })] });
    await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(envMock.mock.calls.at(-1)?.[0]?.profileId).toBe('a');

    // A rate-limit swap to profile b copies the transcript into b's config dir first
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(path.join(dirA, 'projects', 'proj'), { recursive: true });
    writeFileSync(path.join(dirA, 'projects', 'proj', 's9.jsonl'), '{}');
    scripts.push({ messages: [result('s9')] });
    const outcome = await makeRun({ profileId: 'b', settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    expect(outcome.status).toBe('completed');
    expect(existsSync(path.join(dirB, 'projects', 'proj', 's9.jsonl'))).toBe(true);
    expect(loadClaudeRunInfo(specDir)).toMatchObject({ profileId: 'b', configDir: dirB });
    envMock.mockReset();
    envMock.mockImplementation(async (options) => ({ command: 'claude', env: { ...(options?.extraEnv ?? {}) } }));
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

  it("sends the task's attachments with its first turn like the Claude chat: images, documents and inlined text", async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    writeFileSync(path.join(specDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(specDir, 'notes.md'), '# Notes\nUse the v2 API');
    writeFileSync(path.join(specDir, 'spec.pdf'), '%PDF-1.4');
    scripts.push({ messages: [result('s12')] });
    await makeRun({
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false },
      attachments: [
        { path: path.join(specDir, 'shot.png'), filename: 'shot.png', mimeType: 'image/png' },
        { path: path.join(specDir, 'notes.md'), filename: 'notes.md', mimeType: 'text/markdown' },
        { path: path.join(specDir, 'spec.pdf'), filename: 'spec.pdf', mimeType: 'application/pdf' },
      ],
    }).run();
    const input = spawned[0].input as Array<{ type: string; text?: string; source?: { media_type: string }; title?: string }>;
    expect(input.map((block) => block.type)).toEqual(['text', 'image', 'text', 'document']);
    expect(input[1].source?.media_type).toBe('image/png');
    expect(input[2].text).toContain('<attached_file name="notes.md">\n# Notes\nUse the v2 API');
    expect(input[3]).toMatchObject({ title: 'spec.pdf', source: { media_type: 'application/pdf' } });
  });

  it('reports the files its session and subagents edit inside the worktree', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    const edit = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null) =>
      ({ type: 'assistant', session_id: 's10', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } }) as ClaudeStreamMessage;
    scripts.push({ messages: [
      edit('e1', 'Edit', { file_path: path.join(worktree, 'src', 'a.ts') }),
      edit('e2', 'Write', { file_path: 'docs/notes.md' }, 'agent-1'),
      edit('e3', 'Read', { file_path: path.join(worktree, 'src', 'b.ts') }),
      edit('e4', 'Write', { file_path: path.join(tmpdir(), 'outside.txt') }),
      result('s10'),
    ] });
    const edited: string[][] = [];
    await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }, { onFilesEdited: (files: string[]) => edited.push(files) }).run();
    expect(edited).toEqual([['src/a.ts'], ['docs/notes.md']]);
  });

  it('says nothing about project memory while the self-improve switch is off', async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s12')] });
    await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
    const prompt = argValue(spawned[0].args, '--append-system-prompt') ?? '';
    expect(prompt).not.toContain('## Project memory');
    expect(prompt).not.toContain('type: feedback');
  });

  it("tells the session to save what it learns once the project's switch is on", async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    scripts.push({ messages: [result('s13')] });
    await makeRun({
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false },
      selfImprovePrompt: SELF_IMPROVE_NUDGE,
    }).run();
    const prompt = argValue(spawned[0].args, '--append-system-prompt') ?? '';
    expect(prompt).toContain('## Project memory');
    expect(prompt).toContain('type: feedback');
  });

  it("lists the other tasks' unmerged changes in each phase's system prompt", async () => {
    triageMock.mockResolvedValue({ triage: triage() });
    const tasksDir = path.dirname(specDir);
    const otherSpec = mkdtempSync(path.join(tasksDir, 'other-'));
    const changelogPath = path.join(worktree, 'changelog.jsonl');
    writeFileSync(changelogPath, [
      { at: '2026-10-11T10:00:00Z', task: path.basename(otherSpec), title: 'Other', event: 'state', status: 'in_progress', state: 'coding', files: [] },
      { at: '2026-10-11T10:01:00Z', task: path.basename(otherSpec), event: 'edit', files: ['src/shared.ts'] },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    scripts.push({ messages: [result('s11')] });
    try {
      await makeRun({ changelogPath, settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
      const prompt = argValue(spawned[0].args, '--append-system-prompt') ?? '';
      expect(prompt).toContain('## Parallel tasks');
      expect(prompt).toContain(changelogPath);
      expect(prompt).toContain('"Other", In Progress (coding): `src/shared.ts`');
    } finally {
      rmSync(otherSpec, { recursive: true, force: true });
    }
  });
  describe('splitting the ticket', () => {
    const split = {
      reason: 'Too big',
      keepScope: 'Add the subtract function',
      newTickets: [{ title: 'Add divide', description: 'Add a divide function with tests', reason: 'Separate area' }],
    };
    const schemaOf = (index: number) => JSON.parse(argValue(spawned[index].args, '--json-schema')!) as { properties: Record<string, unknown> };
    const inputText = (index: number) => JSON.stringify(spawned[index].input);

    it('proposes: pauses after planning, keeps the plan aside and emits SPLIT_PROPOSED', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      scripts.push({ messages: [result('s1', { structured_output: { plan: '# Plan for the kept scope', split } })] });
      const events: string[] = [];
      const onSplit = vi.fn(async () => ({ outcome: 'proposed' as const, proposalId: 'prop-1' }));
      const outcome = await makeRun({ splitMode: 'propose', projectId: 'p1' }, { onSplit, onTaskEvent: (type: string) => events.push(type) }).run();

      expect(outcome.status).toBe('split_proposed');
      expect(events).toContain('SPLIT_PROPOSED');
      expect(spawned).toHaveLength(1);
      expect(schemaOf(0).properties).toHaveProperty('split');
      expect(inputText(0)).toContain('keepScope');
      expect(onSplit).toHaveBeenCalledWith(expect.objectContaining({ origin: 'plan', mode: 'propose' }));
      const info = loadClaudeRunInfo(specDir)!;
      expect(info.plan).toBeUndefined();
      expect(info.pendingSplit).toEqual({ proposalId: 'prop-1', plan: '# Plan for the kept scope' });
    });

    it('resumes with the reduced scope once the split was applied', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      scripts.push({ messages: [result('s1', { structured_output: { plan: '# Reduced plan', split } })] });
      const callbacks = { onSplit: async () => ({ outcome: 'proposed' as const, proposalId: 'prop-1' }) };
      await makeRun({ splitMode: 'propose', projectId: 'p1' }, callbacks).run();

      scripts.push({ messages: [result('s1', { result: 'Implemented' })] }, { messages: [result('s1', {
        structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] },
      })] });
      const getSplitStatus = vi.fn(async () => 'applied' as const);
      const outcome = await makeRun({ splitMode: 'propose', projectId: 'p1' }, { ...callbacks, getSplitStatus }).run();

      expect(outcome.status).toBe('completed');
      // No second plan: the next spawned run is the implementation, with the saved plan
      expect(spawned).toHaveLength(3);
      expect(argValue(spawned[1].args, '--permission-mode')).toBeUndefined();
      const info = loadClaudeRunInfo(specDir)!;
      expect(info.plan).toBe('# Reduced plan');
      expect(info.pendingSplit).toBeUndefined();
      expect(readFileSync(path.join(specDir, 'plan.md'), 'utf-8')).toBe('# Reduced plan');
    });

    it('plans the whole ticket again, without the split option, once the split was dismissed', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      scripts.push({ messages: [result('s1', { structured_output: { plan: '# Reduced plan', split } })] });
      await makeRun({ splitMode: 'propose', projectId: 'p1' }, { onSplit: async () => ({ outcome: 'proposed' as const, proposalId: 'prop-1' }) }).run();

      scripts.push(
        { messages: [result('s1', { structured_output: { plan: '# Full plan' } })] },
        { messages: [result('s1', { result: 'Implemented' })] },
        { messages: [result('s1', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
      );
      const dismissSplit = vi.fn(async () => undefined);
      const getSplitStatus = vi.fn(async () => 'pending' as const);
      const outcome = await makeRun({ splitMode: 'propose', projectId: 'p1' }, { getSplitStatus, dismissSplit }).run();

      expect(outcome.status).toBe('completed');
      // Resuming without a decision dismisses the proposal
      expect(dismissSplit).toHaveBeenCalledWith('prop-1');
      expect(argValue(spawned[1].args, '--permission-mode')).toBe('plan');
      expect(schemaOf(1).properties).not.toHaveProperty('split');
      expect(inputText(1)).not.toContain('keepScope');
      expect(loadClaudeRunInfo(specDir)!.plan).toBe('# Full plan');
    });

    it('auto: applies at once and goes on implementing the reduced scope', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      scripts.push(
        { messages: [result('s1', { structured_output: { plan: '# Reduced plan', split } })] },
        { messages: [result('s1', { result: 'Implemented' })] },
        { messages: [result('s1', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
      );
      const onSplit = vi.fn(async () => ({ outcome: 'applied' as const, description: 'Add the subtract function' }));
      const outcome = await makeRun({ splitMode: 'auto', projectId: 'p1' }, { onSplit }).run();
      expect(outcome.status).toBe('completed');
      expect(onSplit).toHaveBeenCalledTimes(1);
      expect(loadClaudeRunInfo(specDir)!.plan).toBe('# Reduced plan');
      // The ticket splits once: the implement prompt does not ask for a Deferred section any more
      expect(inputText(1)).not.toContain('## Deferred');
    });

    it('plans the whole ticket again when the split could not be made', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      scripts.push(
        { messages: [result('s1', { structured_output: { plan: '# Reduced plan', split } })] },
        { messages: [result('s1', { structured_output: { plan: '# Full plan' } })] },
        { messages: [result('s1', { result: 'Implemented' })] },
        { messages: [result('s1', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
      );
      const onSplit = vi.fn(async () => ({ outcome: 'ignored' as const, reason: 'nope' }));
      await makeRun({ splitMode: 'auto', projectId: 'p1' }, { onSplit }).run();
      expect(onSplit).toHaveBeenCalledTimes(1);
      expect(loadClaudeRunInfo(specDir)!.plan).toBe('# Full plan');
      expect(schemaOf(1).properties).not.toHaveProperty('split');
    });

    it('leaves the split option out of the schema and prompts when splitting is off or not allowed', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      scripts.push(
        { messages: [result('s1', { structured_output: { plan: '# Plan', split } })] },
        { messages: [result('s1', { result: 'Implemented\n## Deferred\n- more' })] },
        { messages: [result('s1', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
      );
      const onSplit = vi.fn();
      // No splitMode: what the agent manager does for off and for a ticket made by a split
      await makeRun({}, { onSplit }).run();
      expect(schemaOf(0).properties).not.toHaveProperty('split');
      expect(inputText(0)).not.toContain('keepScope');
      expect(inputText(1)).not.toContain('## Deferred');
      expect(onSplit).not.toHaveBeenCalled();
      expect(loadClaudeRunInfo(specDir)!.plan).toBe('# Plan');
    });

    it('moves a Deferred list from the implement answer into one new ticket', async () => {
      triageMock.mockResolvedValue({ triage: triage() });
      scripts.push(
        { messages: [result('s1', { result: 'Added subtract.\n\n## Deferred\n- Add divide\n- Add modulo' })] },
        { messages: [result('s1', { structured_output: { status: 'passed', summary: 'ok', checks: [], findings: [] } })] },
      );
      const onSplit = vi.fn(async () => ({ outcome: 'applied' as const, description: 'Reduced' }));
      await makeRun({ splitMode: 'auto', projectId: 'p1' }, { onSplit }).run();
      expect(inputText(0)).toContain('## Deferred');
      expect(onSplit).toHaveBeenCalledTimes(1);
      const request = (onSplit.mock.calls[0] as unknown as [{ split: { pieces: Array<{ description: string }> }; origin: string }])[0];
      expect(request.origin).toBe('implement');
      expect(request.split.pieces).toHaveLength(1);
      expect(request.split.pieces[0].description).toContain('- Add divide');
      expect(request.split.pieces[0].description).toContain('- Add modulo');
      const keep = (onSplit.mock.calls[0] as unknown as [{ split: { keepScope: string } }])[0].split.keepScope;
      expect(keep).toContain('Added subtract.');
      expect(keep).not.toContain('Deferred');
    });
  });

  describe('in WSL', () => {
    it('reports edited files and the session cwd as host paths', async () => {
      runtimeRef.wsl = true;
      triageMock.mockResolvedValue({ triage: triage() });
      const edit = (id: string, input: Record<string, unknown>) =>
        ({ type: 'assistant', session_id: 's20', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Edit', input }] } }) as ClaudeStreamMessage;
      scripts.push({ messages: [
        { type: 'system', subtype: 'init', session_id: 's20', cwd: '/mnt/wt', tools: [], plugins: [] } as unknown as ClaudeStreamMessage,
        edit('e1', { file_path: '/mnt/wt/src/a.ts' }),
        edit('e2', { file_path: '/home/me/elsewhere.ts' }),
        result('s20'),
      ] });
      const edited: string[][] = [];
      await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }, { onFilesEdited: (files: string[]) => edited.push(files) }).run();

      expect(edited).toEqual([['src/a.ts']]);
      const info = loadClaudeRunInfo(specDir);
      expect(info?.init?.cwd).toBe(worktree);
      expect(info?.runtime).toBe('wsl');
    });

    it('names the changelog by its WSL path and the task folder with forward slashes', async () => {
      runtimeRef.wsl = true;
      triageMock.mockResolvedValue({ triage: triage() });
      const changelogPath = path.join(worktree, 'changelog.jsonl');
      writeFileSync(changelogPath, '');
      scripts.push({ messages: [result('s21')] });
      await makeRun({ changelogPath, settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
      const prompt = argValue(spawned[0].args, '--append-system-prompt') ?? '';
      expect(prompt).toContain(`\`/mnt/host${changelogPath}\``);
      expect(prompt).toContain('`.workbench/tasks/001-task`');
    });

    it('starts a new session, with the task and plan, when the session ran in the other runtime', async () => {
      triageMock.mockResolvedValue({ triage: triage({ needsPlan: true }) });
      // Planned and started natively, then stopped by a crash
      scripts.push(
        { messages: [result('s22', { structured_output: { plan: '# The plan' } })] },
        { messages: [result('s22', { is_error: true, subtype: 'error_during_execution', errors: ['crash'] })] },
      );
      const first = await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
      expect(first.status).toBe('failed');
      expect(loadClaudeRunInfo(specDir)?.runtime).toBe('native');

      // Now Claude Code runs in WSL: the native session can't be resumed there
      runtimeRef.wsl = true;
      scripts.push({ messages: [result('s23')] });
      const logs: string[] = [];
      const second = await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }, { onLog: (line: string) => logs.push(line) }).run();

      expect(second.status).toBe('completed');
      const args = spawned[2].args;
      expect(args).not.toContain('--resume');
      expect(argValue(args, '--session-id')).not.toBe('s22');
      const text = (spawned[2].input as Array<{ type: string; text?: string }>)[0].text ?? '';
      expect(text).toContain('<task title="Task">');
      expect(text).toContain('# The plan');
      expect(text).toContain('An earlier session already worked on this task');
      expect(logs.some((line) => line.includes('starts a new session'))).toBe(true);
      const info = loadClaudeRunInfo(specDir);
      expect(info?.runtime).toBe('wsl');
      expect(info?.sessionId).toBe('s23');
    });

    it('resumes a session that ran in the same runtime', async () => {
      runtimeRef.wsl = true;
      triageMock.mockResolvedValue({ triage: triage() });
      scripts.push({ messages: [result('s24', { is_error: true, subtype: 'error_during_execution', errors: ['crash'] })] });
      await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
      scripts.push({ messages: [result('s24')] });
      await makeRun({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, validation: false } }).run();
      expect(argValue(spawned[1].args, '--resume')).toBe('s24');
    });
  });
});

describe('ompSubagentGuidance', () => {
  it('lets one OMP task fan out to parallel subagents up to its cap, or work alone', () => {
    const parallel = ompSubagentGuidance(3);
    expect(parallel).toContain('task tool in one batch call');
    expect(parallel).toContain('at most 3 at a time');
    expect(parallel).toContain('no two subagents edit the same file');
    expect(ompSubagentGuidance(1)).toBe('- Do the work yourself in this conversation.\n');
    expect(ompSubagentGuidance(0)).toBe('- Do the work yourself in this conversation.\n');
  });

  it('clamps the setting to 0-8 with a default of 3', () => {
    expect(ompSubagentsPerTask({})).toBe(3);
    expect(ompSubagentsPerTask({ subagentsPerTask: 20 })).toBe(8);
    expect(ompSubagentsPerTask({ subagentsPerTask: -2 })).toBe(0);
  });
});
