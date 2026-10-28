import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import type { ClaudeRunInfo } from '../../shared/types/claude-code';
import type { SessionEpoch } from '../../shared/types/task-throughput';
import { buildHandoffPrompt, fingerprintWorktree, loadSessionEpoch, persistSessionEpoch, preparePhaseHandoff, verifyPhaseHandoff } from './phase-handoff';

vi.mock('../utils/git-exec', async () => {
  const { execFile } = await import('child_process');
  return { git: (args: string[], options: { cwd: string; maxBuffer?: number }) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: options.cwd, maxBuffer: options.maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  }) };
});

let root: string;
let repo: string;
let specDir: string;
let runInfo: ClaudeRunInfo;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-phase-handoff-'));
  repo = path.join(root, 'repo'); specDir = path.join(root, 'task');
  await fs.mkdir(repo); await fs.mkdir(specDir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.bin\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'original\n');
  git('add', '.'); git('commit', '-qm', 'base');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'dirty work\n');
  await fs.writeFile(path.join(repo, 'staged.txt'), 'staged work\n'); git('add', 'staged.txt');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'untracked work\n');
  await fs.writeFile(path.join(repo, 'ignored.bin'), 'untouched ignored output');
  await fs.writeFile(path.join(specDir, 'plan.md'), 'The saved plan');
  await fs.writeFile(path.join(specDir, 'task_metadata.json'), JSON.stringify({ humanWork: { revision: 3, items: [{ owner: 'Ian', response: 'Approved current art' }] } }));
  await fs.mkdir(path.join(specDir, 'omp-sessions', 'children'), { recursive: true });
  await fs.writeFile(path.join(specDir, 'omp-sessions', 'old-session.jsonl'), '{"type":"session","id":"old-session"}\n');
  await fs.writeFile(path.join(specDir, 'omp-sessions', 'children', 'advisor.jsonl'), '{"type":"message"}\n');
  runInfo = { version: 1, backend: 'omp', sessionId: 'old-session', phases: [{ name: 'implement', startedAt: '2026-10-28T10:00:00Z', endedAt: '2026-10-28T10:01:00Z', costUsd: 1.5 }], subagents: [], totalCostUsd: 1.5, updatedAt: '2026-10-28T10:01:00Z', plan: 'The saved plan' };
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const prepare = () => preparePhaseHandoff({ specDir, worktreePath: repo, runInfo, nextPhase: 'validate', reason: 'before-validation', boundaryKey: 'implement-1', baseRef: 'main' });

describe('phase handoff preservation', () => {
  it('preserves originals while durably flushing archive copies on systems that reject read-only file fsync', async () => {
    const originalOpen = fs.open.bind(fs);
    const before = await fingerprintWorktree(repo, 'main');
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[1] === 'r' && (await handle.stat()).isFile()) {
        handle.sync = async () => { throw Object.assign(new Error('Read-only file handles cannot be flushed'), { code: 'EPERM' }); };
      }
      return handle;
    });
    try {
      const receipt = await prepare();
      await verifyPhaseHandoff(receipt, { worktreePath: repo, requireCurrentWorktree: true });
      expect(await fingerprintWorktree(repo, 'main')).toBe(before);
      expect(await fs.readFile(path.join(receipt.path, 'sessions', '0', 'omp-sessions', 'old-session.jsonl'), 'utf8')).toBe(await fs.readFile(path.join(specDir, 'omp-sessions', 'old-session.jsonl'), 'utf8'));
    } finally { open.mockRestore(); }
  });

  it('does not publish preservation when flushing an owned archive copy fails', async () => {
    const originalOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(path.join('untracked', 'untracked.txt'))) {
        handle.sync = async () => { throw Object.assign(new Error('Archive flush failed'), { code: 'EIO' }); };
      }
      return handle;
    });
    try {
      await expect(prepare()).rejects.toMatchObject({ code: 'EIO' });
      const entries = await fs.readdir(path.join(specDir, 'phase-handoffs'));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((name) => name.includes('.preparing-'))).toBe(true);
      expect(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
      expect(await fs.readFile(path.join(specDir, 'omp-sessions', 'old-session.jsonl'), 'utf8')).toContain('old-session');
    } finally { open.mockRestore(); }
  });

  it('preserves staged, dirty, untracked and raw child transcripts without moving or modifying originals', async () => {
    const before = await fingerprintWorktree(repo, 'main');
    const status = git('status', '--porcelain=v1');
    const receipt = await prepare();
    await verifyPhaseHandoff(receipt, { worktreePath: repo, requireCurrentWorktree: true });
    expect(await fingerprintWorktree(repo, 'main')).toBe(before);
    expect(git('status', '--porcelain=v1')).toBe(status);
    expect(await fs.readFile(path.join(repo, 'ignored.bin'), 'utf8')).toBe('untouched ignored output');
    expect(await fs.readFile(path.join(receipt.path, 'untracked', 'untracked.txt'), 'utf8')).toBe('untracked work\n');
    expect(await fs.readFile(path.join(receipt.path, 'working.patch'), 'utf8')).toContain('+dirty work');
    expect(await fs.readFile(path.join(receipt.path, 'index.patch'), 'utf8')).toContain('+staged work');
    expect(JSON.parse(await fs.readFile(path.join(receipt.path, 'run-snapshot.json'), 'utf8'))).toEqual(runInfo);
    const manifest = JSON.parse(await fs.readFile(receipt.manifestPath, 'utf8'));
    expect(manifest.files.map((file: { path: string }) => file.path)).toContain(path.join('sessions', '0', 'omp-sessions', 'children', 'advisor.jsonl'));
    expect(await fs.readFile(path.join(specDir, 'omp-sessions', 'old-session.jsonl'), 'utf8')).toContain('old-session');
    expect(JSON.parse(await fs.readFile(path.join(receipt.path, 'task_metadata.json'), 'utf8')).humanWork.revision).toBe(3);
    // Prove the receipt can restore the tracked index/worktree split in a separate checkout.
    const restored = path.join(root, 'restored');
    execFileSync('git', ['clone', '-q', repo, restored]);
    execFileSync('git', ['apply', '--index', path.join(receipt.path, 'index.patch')], { cwd: restored });
    execFileSync('git', ['apply', path.join(receipt.path, 'working.patch')], { cwd: restored });
    await fs.copyFile(path.join(receipt.path, 'untracked', 'untracked.txt'), path.join(restored, 'untracked.txt'));
    expect(execFileSync('git', ['status', '--porcelain=v1'], { cwd: restored, encoding: 'utf8' }).trim()).toBe(status);
    expect(await fs.readFile(path.join(restored, 'tracked.txt'), 'utf8')).toBe('dirty work\n');
    expect((await prepare()).digest).toBe(receipt.digest);
  });

  it('fingerprints untracked content changes and rejects a stale prepared handoff', async () => {
    const receipt = await prepare();
    const before = await fingerprintWorktree(repo);
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'changed after checkpoint\n');
    expect(await fingerprintWorktree(repo)).not.toBe(before);
    await expect(verifyPhaseHandoff(receipt, { worktreePath: repo, requireCurrentWorktree: true })).rejects.toThrow('Worktree changed');
    await expect(prepare()).rejects.toThrow('Worktree changed');
  });

  it('fails verification on a corrupt archive instead of silently reusing or overwriting it', async () => {
    const receipt = await prepare();
    await fs.writeFile(path.join(receipt.path, 'untracked', 'untracked.txt'), 'corrupt');
    await expect(verifyPhaseHandoff(receipt)).rejects.toThrow('failed verification');
    await expect(prepare()).rejects.toThrow('failed verification');
    expect(await fs.readFile(path.join(repo, 'untracked.txt'), 'utf8')).toBe('untracked work\n');
  });

  it('fails closed for a pending tool/subagent, an in-progress merge, or a missing current transcript', async () => {
    const options = { specDir, worktreePath: repo, runInfo, nextPhase: 'validate', reason: 'manual', boundaryKey: 'pending' };
    await expect(preparePhaseHandoff({ ...options, pendingWork: true })).rejects.toThrow('pending');
    await expect(preparePhaseHandoff({ ...options, runInfo: { ...runInfo, subagents: [{ id: 'child', description: 'still working', status: 'running', startedAt: runInfo.updatedAt }] } })).rejects.toThrow('pending');
    await fs.writeFile(path.join(repo, '.git', 'MERGE_HEAD'), `${git('rev-parse', 'HEAD')}\n`);
    await expect(prepare()).rejects.toThrow('in-progress merge');
    await fs.unlink(path.join(repo, '.git', 'MERGE_HEAD'));
    await fs.unlink(path.join(specDir, 'omp-sessions', 'old-session.jsonl'));
    await expect(prepare()).rejects.toThrow('raw session transcript');
  });

  it('does not publish an interrupted preparation and verifies a later completed retry', async () => {
    await fs.symlink(path.join(root, 'not-a-session'), path.join(specDir, 'omp-sessions', 'bad-link'));
    await expect(prepare()).rejects.toThrow('symlinks');
    const entries = await fs.readdir(path.join(specDir, 'phase-handoffs'));
    expect(entries.every((name) => name.includes('.preparing-'))).toBe(true);
    await fs.unlink(path.join(specDir, 'omp-sessions', 'bad-link'));
    const receipt = await prepare();
    await verifyPhaseHandoff(receipt);
  });

  it('rejects unignored bookkeeping inside the worktree before creating an archive that would copy itself', async () => {
    const inside = path.join(repo, 'unignored-task-state');
    await expect(preparePhaseHandoff({ specDir: inside, worktreePath: repo, runInfo, nextPhase: 'validate', reason: 'manual', boundaryKey: 'inside' })).rejects.toThrow('outside the worktree or gitignored');
    await expect(fs.stat(inside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('copies an explicit Claude transcript and bounds long summaries without truncating their source', async () => {
    const transcript = path.join(root, 'claude-old-session.jsonl');
    await fs.writeFile(transcript, 'full original transcript\n');
    const child = path.join(root, 'claude-old-session', 'subagents', 'agent-child.jsonl');
    await fs.mkdir(path.dirname(child), { recursive: true });
    await fs.writeFile(child, 'full child transcript\n');
    runInfo.backend = 'claude';
    runInfo.summary = 'long finding '.repeat(10_000);
    const receipt = await preparePhaseHandoff({ specDir, worktreePath: repo, runInfo, nextPhase: 'revise', reason: 'manual', boundaryKey: 'claude', transcriptRoots: [transcript] });
    const prompt = await buildHandoffPrompt(receipt);
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8192);
    expect(prompt).toContain('omitted in full');
    expect(prompt).toContain(path.join(receipt.path, 'handoff.json'));
    expect(JSON.parse(await fs.readFile(path.join(receipt.path, 'handoff.json'), 'utf8')).summary).toBe(runInfo.summary);
    expect(await fs.readFile(transcript, 'utf8')).toBe('full original transcript\n');
    const manifest = JSON.parse(await fs.readFile(receipt.manifestPath, 'utf8'));
    const childCopy = manifest.files.find((file: { path: string }) => file.path.endsWith(path.join('subagents', 'agent-child.jsonl')));
    expect(childCopy).toBeDefined();
    expect(await fs.readFile(path.join(receipt.path, childCopy.path), 'utf8')).toBe('full child transcript\n');
    expect(await fs.readFile(child, 'utf8')).toBe('full child transcript\n');
    await verifyPhaseHandoff(receipt);
  });
});

describe('session epoch journal', () => {
  async function epoch(): Promise<SessionEpoch> {
    const handoff = await prepare();
    return { id: 'epoch-1', boundaryKey: handoff.boundaryKey, reason: 'before-validation', priorSessionId: 'old-session', state: 'prepared', handoff, createdAt: handoff.createdAt, updatedAt: handoff.createdAt };
  }
  it('durably acknowledges the chosen session, preserves lineage, and forbids identity or state rewrites', async () => {
    const prepared = await epoch();
    await persistSessionEpoch(specDir, prepared);
    await expect(persistSessionEpoch(specDir, { ...prepared, state: 'running', sessionId: 'new-session' })).rejects.toThrow('transition');
    const acknowledged: SessionEpoch = { ...prepared, state: 'acknowledged', sessionId: 'new-session' };
    await persistSessionEpoch(specDir, acknowledged);
    expect((await loadSessionEpoch(specDir))?.sessionId).toBe('new-session');
    const source = await fs.readFile(path.join(specDir, 'session-epochs', 'epoch-1', 'acknowledged.json'), 'utf8');
    await persistSessionEpoch(specDir, { ...acknowledged, updatedAt: '2026-10-29T00:00:00Z' });
    expect(await fs.readFile(path.join(specDir, 'session-epochs', 'epoch-1', 'acknowledged.json'), 'utf8')).toBe(source);
    await persistSessionEpoch(specDir, { ...acknowledged, state: 'running' });
    await expect(persistSessionEpoch(specDir, prepared)).rejects.toThrow();
    await expect(persistSessionEpoch(specDir, { ...acknowledged, state: 'running', sessionId: 'different' })).rejects.toThrow('identity');
    await expect(persistSessionEpoch(specDir, { ...prepared, id: 'duplicate-boundary' })).rejects.toThrow('already has');
  });

  it('recovers a synced acknowledged artifact after a crash before the current pointer changed', async () => {
    const prepared = await epoch();
    await persistSessionEpoch(specDir, prepared);
    const acknowledged = { ...prepared, state: 'acknowledged', sessionId: 'chosen-before-prompt' };
    await fs.writeFile(path.join(specDir, 'session-epochs', prepared.id, 'acknowledged.json'), JSON.stringify(acknowledged));
    expect(await loadSessionEpoch(specDir)).toEqual(acknowledged);
    expect(JSON.parse(await fs.readFile(path.join(specDir, 'session_epoch.json'), 'utf8')).sessionId).toBe('chosen-before-prompt');
  });

  it('serializes competing preparation identities instead of launching two epochs', async () => {
    const prepared = await epoch();
    const writes = await Promise.allSettled([persistSessionEpoch(specDir, prepared), persistSessionEpoch(specDir, { ...prepared, id: 'other-epoch' })]);
    expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1);
    expect((await loadSessionEpoch(specDir))?.id).toBe('epoch-1');
  });

  it('retains consumed requests and rejects a backend/runtime change within an acknowledged epoch', async () => {
    const prepared = { ...await epoch(), backend: 'omp' as const, runtime: 'native' as const, manualRequestIds: ['manual-1'] };
    await persistSessionEpoch(specDir, prepared);
    const acknowledged = { ...prepared, state: 'acknowledged' as const, sessionId: 'new-session' };
    await persistSessionEpoch(specDir, acknowledged);
    expect((await loadSessionEpoch(specDir))?.manualRequestIds).toEqual(['manual-1']);
    await expect(persistSessionEpoch(specDir, { ...acknowledged, state: 'running', backend: 'claude' })).rejects.toThrow('identity');
    await expect(persistSessionEpoch(specDir, { ...acknowledged, state: 'running', runtime: 'wsl' })).rejects.toThrow('identity');
  });
});
