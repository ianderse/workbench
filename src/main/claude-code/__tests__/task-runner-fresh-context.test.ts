import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeTaskRun, loadClaudeRunInfo, type TaskRunConfig } from '../task-runner';
import * as handoffs from '../phase-handoff';
import type { SessionEpoch } from '../../../shared/types/task-throughput';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS, type ClaudeRunInfo } from '../../../shared/types/claude-code';

vi.mock('../../utils/git-exec', async () => {
  const { execFile } = await import('child_process');
  return { git: (args: string[], options: { cwd: string; maxBuffer?: number }) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: options.cwd, maxBuffer: options.maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  }) };
});
vi.mock('../../platform/shell-runtime', () => ({ whenShellRuntimeReady: async () => ({}), getWslInfo: () => null, toHostPath: (value: string) => value, toRuntimePath: (value: string) => value }));

interface FreshRun {
  info: ClaudeRunInfo;
  epoch?: SessionEpoch;
  prepareFreshContext(name: 'implement' | 'validate' | 'revise'): Promise<void>;
  acknowledgeEpoch(sessionId: string): Promise<void>;
  buildInput(name: 'validate', continuing: boolean, resume: boolean): Array<{ text?: string }>;
}
let root: string;
let worktree: string;
let specDir: string;
let initial: ClaudeRunInfo;
const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' }).trim();
const rawPath = (session: string) => path.join(specDir, 'omp-sessions', `${session}.jsonl`);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-runner-fresh-'));
  worktree = path.join(root, 'repo'); specDir = path.join(root, 'task');
  await fs.mkdir(worktree); await fs.mkdir(path.join(specDir, 'omp-sessions'), { recursive: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(worktree, 'tracked.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
  await fs.writeFile(path.join(worktree, 'tracked.txt'), 'dirty work\n');
  await fs.writeFile(path.join(worktree, 'untracked.txt'), 'untracked work\n');
  await fs.writeFile(rawPath('old-session'), '{"type":"session","id":"old-session"}\n');
  await fs.writeFile(path.join(specDir, 'task_metadata.json'), JSON.stringify({ humanWork: { revision: 13, items: [{ owner: 'Ian', response: 'Reviewed the art asset, approved as is.' }] } }));
  await fs.writeFile(path.join(specDir, 'plan.md'), '# Approved implementation plan');
  initial = { version: 1, backend: 'omp', runtime: 'native', sessionId: 'old-session', plan: '# Approved implementation plan', totalCostUsd: 2.5,
    updatedAt: '2026-10-28T12:00:00Z', subagents: [], phases: [{ name: 'implement', sessionId: 'old-session', startedAt: '2026-10-28T11:00:00Z', endedAt: '2026-10-28T12:00:00Z', costUsd: 2.5 }] };
  await fs.writeFile(path.join(specDir, 'claude_run.json'), JSON.stringify(initial));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
function run(extra: Partial<TaskRunConfig> = {}): FreshRun {
  return new ClaudeTaskRun({ taskId: 't', specId: '001-t', specDir, worktreePath: worktree, branch: 'main', baseBranch: 'main', title: 'Task', description: 'Complete the existing task',
    backend: 'omp', mode: 'start', attachments: [], settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS }, ...extra }) as unknown as FreshRun;
}

describe('durable fresh-context continuation', () => {
  it('preserves raw sessions, dirty/untracked work, plan, human metadata, phase history and spending before automatic rotation', async () => {
    const before = await handoffs.fingerprintWorktree(worktree, 'main');
    const metadata = await fs.readFile(path.join(specDir, 'task_metadata.json'), 'utf8');
    const task = run();
    await task.prepareFreshContext('validate');
    expect(task.epoch?.state).toBe('prepared');
    expect(task.info.sessionId).toBeUndefined();
    expect(task.info.phases).toEqual(initial.phases);
    expect(task.info.totalCostUsd).toBe(2.5);
    expect(task.info.plan).toBe(initial.plan);
    expect(await handoffs.fingerprintWorktree(worktree, 'main')).toBe(before);
    expect(await fs.readFile(rawPath('old-session'), 'utf8')).toBe('{"type":"session","id":"old-session"}\n');
    expect(await fs.readFile(path.join(specDir, 'task_metadata.json'), 'utf8')).toBe(metadata);
    expect(task.buildInput('validate', false, false)[0].text).toContain(task.epoch!.handoff.path);
    await handoffs.verifyPhaseHandoff(task.epoch!.handoff, { worktreePath: worktree, requireCurrentWorktree: true });
  });

  it('resumes an acknowledged replacement with the same manual request instead of rotating again', async () => {
    const task = run({ freshContextRequestId: 'request-1' });
    await task.prepareFreshContext('implement');
    expect(task.info.freshContextConsumedRequestId).toBeUndefined();
    await task.acknowledgeEpoch('replacement');
    await fs.writeFile(rawPath('replacement'), '{"type":"session","id":"replacement"}\n');
    const id = task.epoch!.id;
    const resumed = run({ freshContextRequestId: 'request-1' });
    await resumed.prepareFreshContext('implement');
    expect(resumed.epoch?.id).toBe(id);
    expect(resumed.info.sessionId).toBe('replacement');
    expect(resumed.info.freshContextConsumedRequestId).toBe('request-1');
    expect(loadClaudeRunInfo(specDir)?.freshContextConsumedRequestId).toBe('request-1');
    expect(await fs.readdir(path.join(specDir, 'phase-handoffs'))).toHaveLength(1);
    await resumed.acknowledgeEpoch('replacement');
    await expect(resumed.acknowledgeEpoch('different')).rejects.toThrow('identity changed');
  });

  it('never replays an acknowledged request whose replacement transcript is absent, during restart or retry', async () => {
    const task = run({ freshContextRequestId: 'request-unknown' });
    await task.prepareFreshContext('implement');
    await task.acknowledgeEpoch('possibly-accepted');
    await expect(task.acknowledgeEpoch('possibly-accepted')).rejects.toThrow('potentially accepted prompt');
    const restored = run({ freshContextRequestId: 'request-unknown' });
    await expect(restored.prepareFreshContext('implement')).rejects.toThrow('outcome is uncertain');
    expect(await fs.readdir(path.join(specDir, 'phase-handoffs'))).toHaveLength(1);
    expect((await handoffs.loadSessionEpoch(specDir))?.sessionId).toBe('possibly-accepted');
    expect(await fs.readFile(rawPath('old-session'), 'utf8')).toContain('old-session');
  });

  it('recovers a prepared, never-acknowledged transition without duplicating the preservation archive', async () => {
    const first = run({ freshContextRequestId: 'prepared-request' });
    await first.prepareFreshContext('implement');
    const restored = run({ freshContextRequestId: 'prepared-request' });
    await restored.prepareFreshContext('implement');
    expect(restored.epoch?.id).toBe(first.epoch?.id);
    expect(restored.info.sessionId).toBeUndefined();
    expect(await fs.readdir(path.join(specDir, 'phase-handoffs'))).toHaveLength(1);
  });

  it('defers automatic rotation on preservation failure and leaves the original session usable, while manual requests fail clearly', async () => {
    vi.spyOn(handoffs, 'preparePhaseHandoff').mockRejectedValue(new Error('Archive verification failed'));
    const automatic = run();
    await automatic.prepareFreshContext('validate');
    expect(automatic.info.sessionId).toBe('old-session');
    expect(automatic.epoch).toBeUndefined();
    const manual = run({ freshContextRequestId: 'explicit-request' });
    await expect(manual.prepareFreshContext('implement')).rejects.toThrow('Archive verification failed');
    expect(manual.info.sessionId).toBe('old-session');
  });

  it('keeps document attachments intact and defers automatic rotation rather than dropping them', async () => {
    const pdf = { path: path.join(specDir, 'original.pdf'), filename: 'original.pdf', mimeType: 'application/pdf' };
    await fs.writeFile(pdf.path, 'original PDF bytes');
    const automatic = run({ attachments: [pdf] });
    await automatic.prepareFreshContext('validate');
    expect(automatic.info.sessionId).toBe('old-session');
    expect(await fs.readFile(pdf.path, 'utf8')).toBe('original PDF bytes');
    await expect(run({ attachments: [pdf], freshContextRequestId: 'manual-pdf' }).prepareFreshContext('implement')).rejects.toThrow('document attachments');
  });
});
