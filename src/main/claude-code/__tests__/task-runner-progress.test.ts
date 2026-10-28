import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeTaskRun, loadClaudeRunInfo, type TaskRunConfig } from '../task-runner';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS, type ClaudeRunInfo, type ValidationReport } from '../../../shared/types/claude-code';
import { DEFAULT_OMP_BACKEND_SETTINGS } from '../../../shared/types/agent-backend';
import * as backend from '../../agent-backend/settings';
import * as roles from '../../agent-backend/omp-roles';
import * as cooldowns from '../../agent-backend/omp-cooldown';
import * as process from '../../agent-backend/omp-process';
import * as handoffs from '../phase-handoff';
import * as reviewDiff from '../review-diff';

vi.mock('../../utils/git-exec', async () => {
  const { execFile } = await import('child_process');
  return { git: (args: string[], options: { cwd: string; maxBuffer?: number }) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: options.cwd, maxBuffer: options.maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  }) };
});
vi.mock('../../platform/shell-runtime', () => ({ whenShellRuntimeReady: async () => ({}), getWslInfo: () => null, toHostPath: (value: string) => value, toRuntimePath: (value: string) => value }));
vi.mock('../review-summary', async (original) => ({ ...await original<typeof import('../review-summary')>(), generateReviewSummary: async () => null }));

let root: string, worktree: string, specDir: string;
let initial: ClaudeRunInfo;
let spawned: Array<Parameters<typeof process.startOmpProcess>[0]>;
let onLaunch: ((name: string, index: number) => Promise<void>) | undefined;
let failedPhase: string | undefined;
let report: ValidationReport;
let allowFallback: boolean;
let blocked: Record<string, cooldowns.OmpProviderCooldown>;
let toolMode: 'completed' | 'pending' | undefined;
const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
const raw = (session: string) => path.join(specDir, 'omp-sessions', `${session}.jsonl`);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-runner-progress-'));
  worktree = path.join(root, 'repo'); specDir = path.join(root, 'task');
  await fs.mkdir(worktree); await fs.mkdir(path.join(specDir, 'omp-sessions'), { recursive: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(worktree, 'tracked.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.writeFile(path.join(specDir, 'task_metadata.json'), '{"humanWork":{"revision":1}}');
  await fs.writeFile(raw('initial-session'), '{"type":"session","id":"initial-session"}\n');
  initial = { version: 1, backend: 'omp', runtime: 'native', sessionId: 'initial-session', phases: [], subagents: [], totalCostUsd: 0, updatedAt: new Date().toISOString(),
    triage: { model: 'sonnet', effort: 'medium', needsPlan: false, scope: 'small', title: 'Fix parser', reasoning: 'Fixture', verification: ['npm test'], source: 'fixed' } };
  report = { status: 'failed', summary: 'Parser check still fails', checks: [{ name: 'parser', command: 'npm test', passed: false }], findings: [] };
  spawned = []; onLaunch = undefined; failedPhase = undefined; allowFallback = false; blocked = {}; toolMode = undefined;
  roles.resetOmpRolesForTests({ default: 'local/worker' }, { 'local/worker': ['cloud/fallback'] }, false);
  vi.spyOn(roles, 'getOmpFallbackPolicy').mockImplementation(async () => ({ roles: { default: 'local/worker' }, chains: { 'local/worker': ['cloud/fallback'] } }));
  vi.spyOn(backend, 'getAgentBackendSettings').mockImplementation(() => ({ kind: 'omp', omp: { ...DEFAULT_OMP_BACKEND_SETTINGS, advisor: 'off', allowFallbackModels: allowFallback, maxRetries: 0 } }));
  vi.spyOn(cooldowns, 'getOmpCooldownStore').mockReturnValue({ active: async () => blocked } as cooldowns.OmpCooldownStore);
  vi.spyOn(reviewDiff, 'collectReviewDiff').mockResolvedValue('');
  vi.spyOn(process, 'startOmpProcess').mockImplementation(async (options) => {
    spawned.push(options);
    const name = options.label!.split(' ').at(-1)!;
    const index = spawned.length;
    await onLaunch?.(name, index);
    const sessionId = options.session?.resume ?? `replacement-${index}`;
    await options.onSessionReady?.(sessionId);
    await fs.writeFile(raw(sessionId), `{"type":"session","id":"${sessionId}"}\n`);
    if (toolMode) {
      options.onMessage?.({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `read-${index}`, name: 'Read', input: { file_path: 'tracked.txt' } }] } });
      if (toolMode === 'completed') options.onMessage?.({ type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: `read-${index}`, content: 'base' }] } });
    }
    const result = { type: 'result' as const, subtype: 'success', is_error: failedPhase === name, session_id: sessionId, result: failedPhase === name ? 'Provider failed' : 'Done',
      num_turns: 10, total_cost_usd: 0.25, duration_ms: 1000, ...(name === 'validate' ? { structured_output: report } : {}) };
    options.onMessage?.(result);
    return { child: {}, stop: vi.fn(), send: () => false, done: Promise.resolve({ result, results: [], resultOrigins: [], unread: [], exitCode: 0, signal: null, stderr: '', aborted: false, timedOut: false }) } as unknown as Awaited<ReturnType<typeof process.startOmpProcess>>;
  });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

async function run(extra: Partial<TaskRunConfig> = {}, save = true) {
  if (save) await fs.writeFile(path.join(specDir, 'claude_run.json'), JSON.stringify(initial));
  return new ClaudeTaskRun({ taskId: 'task', specId: '001-task', specDir, worktreePath: worktree, branch: 'main', baseBranch: 'main', title: 'Fix parser', description: 'Fix parser correctness',
    backend: 'omp', mode: 'start', attachments: [], settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, taskMessaging: false, freshContext: 'off', stallRecovery: 'recover', aiReviewRounds: 3 }, ...extra }).run();
}
const names = () => spawned.map((options) => options.label!.split(' ').at(-1));

describe('phase-boundary progress recovery through the public runner', () => {
  it('warns, preserves one fresh recovery and stops within the default review cap without losing blockers or spending', async () => {
    const logs: string[] = [];
    await fs.writeFile(path.join(specDir, 'claude_run.json'), JSON.stringify(initial));
    const task = new ClaudeTaskRun({ taskId: 'task', specId: '001-task', specDir, worktreePath: worktree, branch: 'main', baseBranch: 'main', title: 'Fix parser', description: 'Fix parser correctness', backend: 'omp', mode: 'start', attachments: [],
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, taskMessaging: false, freshContext: 'off' } }, { onLog: (line) => logs.push(line) });
    const outcome = await task.run();
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Task stalled');
    expect(names()).toEqual(['implement', 'validate', 'revise', 'validate', 'revise']);
    const saved = loadClaudeRunInfo(specDir)!;
    expect(saved.reviewRounds).toHaveLength(2);
    expect(saved.phaseProgress).toMatchObject({ freshContextRecoveries: 1, fallbackRecoveries: 0 });
    expect(saved.phaseProgress!.lastEvidence!.failedChecks).toEqual(['parser: npm test']);
    expect(saved.totalCostUsd).toBe(1.25);
    expect(logs.some((line) => line.includes('Progress watchdog'))).toBe(true);
    expect(saved.sessionEpoch?.reason).toBe('stagnation');
    await handoffs.verifyPhaseHandoff(saved.sessionEpoch!.handoff);
    expect(await fs.readFile(raw('initial-session'), 'utf8')).toContain('initial-session');
    const count = spawned.length;
    expect((await run({}, false)).status).toBe('failed');
    expect(spawned).toHaveLength(count);
  });

  it('uses exactly one authorized configured fallback on a normal phase and records its concrete model', async () => {
    allowFallback = true;
    const outcome = await run({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, freshContext: 'off', aiReviewRounds: 5 } });
    expect(outcome.status).toBe('failed');
    expect(spawned.filter((options) => options.model === 'cloud/fallback')).toHaveLength(1);
    const saved = loadClaudeRunInfo(specDir)!;
    expect(saved.phaseProgress).toMatchObject({ freshContextRecoveries: 1, fallbackRecoveries: 1 });
    expect(saved.phases.some((phase) => phase.model === 'cloud/fallback')).toBe(true);
    expect(saved.reviewRounds!.length).toBeLessThanOrEqual(5);
  });

  it.each(['pin', 'cooldown', 'disabled'] as const)('does not route to a fallback when %s prevents it', async (reason) => {
    allowFallback = reason !== 'disabled';
    if (reason === 'cooldown') blocked.cloud = { provider: 'cloud', resetAt: '2099-01-01T00:00:00Z' };
    const outcome = await run({ ...(reason === 'pin' ? { agentOverride: { model: 'local/worker' } } : {}), settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, freshContext: 'off', aiReviewRounds: 5 } });
    expect(outcome.status).toBe('failed');
    expect(spawned.some((options) => options.model === 'cloud/fallback')).toBe(false);
    expect(loadClaudeRunInfo(specDir)!.phaseProgress?.fallbackRecoveries).toBe(0);
  });

  it('keeps the saved eligible fallback when an earlier candidate leaves cooldown before its launch', async () => {
    allowFallback = true;
    blocked['cloud-a'] = { provider: 'cloud-a', resetAt: '2099-01-01T00:00:00Z' };
    vi.mocked(roles.getOmpFallbackPolicy).mockImplementation(async () => {
      if (loadClaudeRunInfo(specDir)?.phaseRecovery?.action === 'configured-fallback') blocked = {};
      return { roles: { default: 'local/worker' }, chains: { 'local/worker': ['cloud-a/fallback', 'cloud-b/fallback'] } };
    });
    expect((await run({ settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, freshContext: 'off', aiReviewRounds: 5 } })).status).toBe('failed');
    expect(spawned.filter((options) => options.model === 'cloud-b/fallback')).toHaveLength(1);
    expect(spawned.some((options) => options.model === 'cloud-a/fallback')).toBe(false);
    expect(loadClaudeRunInfo(specDir)?.phaseProgress?.fallbackRecoveries).toBe(1);
  });

  it('keeps saved review rounds across interrupted repair and never grants a new cap after restart', async () => {
    onLaunch = async (name) => { if (name === 'revise') throw new Error('Simulated process interruption'); };
    const settings = { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, freshContext: 'off' as const, stallRecovery: 'off' as const };
    expect((await run({ settings })).status).toBe('failed');
    expect(loadClaudeRunInfo(specDir)!.reviewRounds).toHaveLength(1);
    onLaunch = undefined;
    const outcome = await run({ settings }, false);
    expect(outcome.status).toBe('completed');
    expect(names().filter((name) => name === 'validate')).toHaveLength(3);
    expect(loadClaudeRunInfo(specDir)!.reviewRounds).toHaveLength(3);
  });

  it('fails a preservation recovery once, durably, while retaining the original session and work', async () => {
    vi.spyOn(handoffs, 'preparePhaseHandoff').mockRejectedValue(new Error('Archive disk unavailable'));
    expect((await run()).error).toContain('could not safely preserve');
    const saved = loadClaudeRunInfo(specDir)!;
    expect(saved.phaseRecovery).toMatchObject({ action: 'fresh-context', state: 'failed' });
    expect(saved.sessionId).toBe('initial-session');
    const calls = spawned.length;
    expect((await run({}, false)).status).toBe('failed');
    expect(spawned).toHaveLength(calls);
    expect(await fs.readFile(raw('initial-session'), 'utf8')).toContain('initial-session');
  });

  it('never observes or interrupts an active long-running command, nor counts provider failures', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    onLaunch = async () => { entered(); await waiting; };
    failedPhase = 'implement';
    const pending = run();
    await started;
    expect(loadClaudeRunInfo(specDir)?.phaseProgress).toBeUndefined();
    expect(spawned).toHaveLength(1);
    release();
    expect((await pending).status).toBe('failed');
    expect(loadClaudeRunInfo(specDir)?.phaseProgress).toBeUndefined();
    expect(spawned).toHaveLength(1);
  });

  it.each(['completed', 'pending'] as const)('distinguishes a %s tool from a still-active command at the phase boundary', async (mode) => {
    toolMode = mode;
    const outcome = await run();
    const saved = loadClaudeRunInfo(specDir)!;
    if (mode === 'completed') {
      expect(outcome.status).toBe('failed');
      expect(saved.phaseProgress?.freshContextRecoveries).toBe(1);
      expect(saved.sessionEpoch?.reason).toBe('stagnation');
    } else {
      expect(outcome.status).toBe('completed');
      expect(saved.phaseProgress?.consecutiveNoProgress).toBe(0);
      expect(saved.sessionEpoch).toBeUndefined();
    }
  });

  it('does not consume a recovery budget when the only remaining gate needs a person', async () => {
    report = { status: 'failed', summary: 'Needs a real observation', checks: [], findings: [{ severity: 'major', description: 'Participant observation required', fixed: false, requiresHuman: true }] };
    initial.phases.push({ name: 'implement', startedAt: '2026-10-28T12:00:00Z', endedAt: '2026-10-28T12:01:00Z', sessionId: 'initial-session' });
    initial.phaseProgress = { version: 1, evaluatedPhaseKeys: [], consecutiveNoProgress: 2, freshContextRecoveries: 0, fallbackRecoveries: 0,
      lastEvidence: { repositoryFingerprint: await handoffs.fingerprintWorktree(worktree), failedChecks: [], openFindings: ['major: participant observation required'] },
      lastValidationSignature: JSON.stringify([[], ['major: participant observation required']]), updatedAt: new Date().toISOString() };
    expect((await run()).status).toBe('completed');
    expect(names()).toEqual(['validate']);
    expect(loadClaudeRunInfo(specDir)?.phaseProgress).toMatchObject({ freshContextRecoveries: 0, fallbackRecoveries: 0, consecutiveNoProgress: 0 });
    expect(loadClaudeRunInfo(specDir)?.phaseRecovery).toBeUndefined();
  });

  it('retries an interrupted prepared recovery with the same receipt and durable budget', async () => {
    let interrupted = false;
    onLaunch = async () => {
      if (loadClaudeRunInfo(specDir)?.phaseRecovery?.state === 'pending' && !interrupted) { interrupted = true; throw new Error('Interrupted before session acknowledgment'); }
    };
    expect((await run()).status).toBe('failed');
    const before = loadClaudeRunInfo(specDir)!;
    expect(before.phaseRecovery).toMatchObject({ action: 'fresh-context', state: 'pending', targetPhase: 'revise' });
    expect(before.sessionEpoch?.state).toBe('prepared');
    const epochId = before.sessionEpoch!.id;
    onLaunch = undefined;
    expect((await run({}, false)).status).toBe('failed');
    const after = loadClaudeRunInfo(specDir)!;
    expect(after.phaseProgress?.freshContextRecoveries).toBe(1);
    expect(after.sessionEpoch?.id).toBe(epochId);
    expect(await fs.readdir(path.join(specDir, 'phase-handoffs'))).toHaveLength(1);
    expect(after.reviewRounds).toHaveLength(2);
  });
});
