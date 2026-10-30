import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { SpecReviewReport } from '../shared/types/spec-review';

vi.mock('./cli-tool-manager', () => ({ getToolPathAsync: async () => 'git', getToolInfoAsync: async () => ({ found: true, version: '2.43.0' }) }));
vi.mock('./self-improve/setting', () => ({ isSelfImproveEnabledForPath: async () => false }));

import * as autonomousGit from './autonomous/autonomous-git';
import { isSpecReviewProgressPublished, publishSpecReviewProgress, renderSpecReviewProgress, SPEC_REVIEW_PROGRESS_END, SPEC_REVIEW_PROGRESS_START } from './spec-review-progress';

let project: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file: string, content: string) => writeFileSync(path.join(project, file), content);
const read = (file = 'PROGRESS.md') => readFileSync(path.join(project, file), 'utf8');
const commit = (file: string, content: string) => { write(file, content); git('add', '--', file); git('commit', '-qm', `Update ${file}`); return git('rev-parse', 'HEAD'); };
const pending = (): SpecReviewReport => ({
  complete: false, checksObserved: false, summary: 'Implementation exists; live verification remains open.',
  sections: [{ section: 'Recovery', status: 'partial', evidence: 'The restart probe did not run.' }],
  gaps: [{ key: 'restart', title: 'Observe restart recovery', description: 'Run the restart probe', specSection: 'Recovery', evidence: 'No probe result', dependsOn: [] }],
});
const input = (overrides: Partial<Parameters<typeof publishSpecReviewProgress>[0]> = {}) => ({
  projectPath: project, targetBranch: 'main', taskId: '024-review-recovery', round: 2,
  reviewedAt: '2026-10-30T13:21:00.000Z', reviewedRevision: 'a'.repeat(40), report: pending(), ...overrides,
});

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), 'spec-review-progress-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Review fixture'); git('config', 'user.email', 'review@example.com');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  commit('PROGRESS.md', '# Authored progress\nKeep this evidence and its owner gate.\n');
  commit('source.ts', 'original\n');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(project, { recursive: true, force: true }); });

describe('host-owned spec review progress', () => {
  it('publishes only the canonical document while preserving staged, dirty and untracked work', async () => {
    write('source.ts', 'staged\n'); git('add', 'source.ts'); write('source.ts', 'dirty after staging\n'); write('scratch.txt', 'untracked\n');
    const staged = git('diff', '--cached'); const dirty = git('diff');
    const before = git('rev-parse', 'HEAD');
    const receipt = await publishSpecReviewProgress(input());
    expect(receipt).toMatchObject({ changed: true, branch: 'main', reviewedRevision: 'a'.repeat(40) });
    expect(git('rev-parse', 'HEAD')).toBe(receipt.commit);
    expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', receipt.commit)).toBe('PROGRESS.md');
    expect(git('rev-parse', `${receipt.commit}^`)).toBe(before);
    expect(git('diff', '--cached')).toBe(staged); expect(git('diff')).toBe(dirty); expect(read('scratch.txt')).toBe('untracked\n');
    expect(read()).toContain('revision aaaaaaaaaaaa'); expect(read()).toContain('1 gaps; checks not established');
    expect(read()).toContain('Pending sections: Recovery'); expect(read()).toContain('not owner acceptance');
    expect(read()).not.toContain(before.slice(0, 12));
  });

  it('serializes concurrent identical publications and deduplicates against branch content', async () => {
    const count = Number(git('rev-list', '--count', 'HEAD'));
    const [first, second] = await Promise.all([publishSpecReviewProgress(input()), publishSpecReviewProgress(input())]);
    expect(first.commit).toBe(second.commit); expect(first.changed).toBe(true); expect(second.changed).toBe(false);
    expect(Number(git('rev-list', '--count', 'HEAD'))).toBe(count + 1);
    commit('source.ts', 'later unrelated work\n');
    const retried = await publishSpecReviewProgress(input());
    expect(retried.commit).toBe(first.commit); expect(retried.changed).toBe(false);
    expect(read().split(SPEC_REVIEW_PROGRESS_START)).toHaveLength(2);
  });

  it('honors autocrlf normalization while preserving authored contents and the doc-only contract', async () => {
    const authored = read();
    expect(authored).not.toContain('\r');
    git('config', 'core.autocrlf', 'true');
    rmSync(path.join(project, 'PROGRESS.md')); git('checkout', '--', 'PROGRESS.md');
    expect(read()).toBe(authored.replace(/\n/g, '\r\n'));
    const receipt = await publishSpecReviewProgress(input());
    const blob = execFileSync('git', ['show', `${receipt.commit}:PROGRESS.md`], { cwd: project, encoding: 'utf8' });
    expect(blob.startsWith(authored)).toBe(true); expect(blob).not.toContain('\r');
    expect(blob).toContain('Ticket: 024-review-recovery');
    expect(read().startsWith(authored.replace(/\n/g, '\r\n'))).toBe(true);
    expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', receipt.commit)).toBe('PROGRESS.md');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('trusts a receipt only while its commit remains reachable from its local target', async () => {
    const base = git('rev-parse', 'HEAD'); git('branch', 'review-target');
    const receipt = await publishSpecReviewProgress(input({ targetBranch: 'review-target' }));
    expect(await isSpecReviewProgressPublished(project, receipt)).toBe(true);
    expect(await isSpecReviewProgressPublished(project, { ...receipt, branch: 'missing-target' })).toBe(false);
    expect(await isSpecReviewProgressPublished(project, { ...receipt, commit: 'f'.repeat(40) })).toBe(false);
    expect(await isSpecReviewProgressPublished(path.join(project, 'missing-repository'), receipt)).toBe(false);
    git('update-ref', 'refs/heads/review-target', base, receipt.commit);
    expect(await isSpecReviewProgressPublished(project, receipt)).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('does not replace a newer review when an older receipt persistence is retried', async () => {
    const old = await publishSpecReviewProgress(input());
    const newer = await publishSpecReviewProgress(input({ taskId: '025-next-review', reviewedAt: '2026-10-30T14:21:00.000Z' }));
    // A lost receipt remains recoverable even after substantial unrelated history.
    for (let index = 0; index < 102; index++) git('commit', '--allow-empty', '-qm', `Unrelated history ${index}`);
    const target = git('rev-parse', 'HEAD');
    const contents = read();
    const retry = await publishSpecReviewProgress(input());
    expect(retry).toMatchObject({ commit: old.commit, changed: false });
    expect(git('merge-base', '--is-ancestor', newer.commit, target)).toBe('');
    expect(git('rev-parse', 'HEAD')).toBe(target); expect(read()).toBe(contents);
    await expect(publishSpecReviewProgress(input({ taskId: '023-delayed-review', reviewedAt: '2026-10-30T12:21:00.000Z' }))).rejects.toThrow(/newer review/);
    expect(read()).toBe(contents);
  });

  it('rerenders on the new local target tip when it moves during publication', async () => {
    const original = autonomousGit.advanceBranch;
    vi.spyOn(autonomousGit, 'advanceBranch').mockImplementationOnce(async () => {
      commit('PROGRESS.md', '# Authored progress\nConcurrent authored addition.\n');
      return 'main moved while updating';
    }).mockImplementation(original);
    const reviewed = git('rev-parse', 'HEAD');
    await publishSpecReviewProgress(input({ reviewedRevision: reviewed }));
    expect(read()).toContain('Concurrent authored addition.'); expect(read()).toContain(`revision ${reviewed.slice(0, 12)}`);
    expect(autonomousGit.advanceBranch).toHaveBeenCalledTimes(2);
    expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('PROGRESS.md');
  });

  it('updates an un-checked-out local branch without switching the user checkout', async () => {
    git('branch', 'review-target');
    const head = git('rev-parse', 'HEAD'); const contents = read();
    const receipt = await publishSpecReviewProgress(input({ targetBranch: 'review-target', reviewedRevision: undefined }));
    expect(git('branch', '--show-current')).toBe('main'); expect(git('rev-parse', 'HEAD')).toBe(head); expect(read()).toBe(contents);
    expect(git('show', `${receipt.commit}:PROGRESS.md`)).toContain('revision unknown');
    expect(git('rev-parse', 'review-target')).toBe(receipt.commit);
  });

  it('creates a missing document and records observed completion without claiming owner acceptance', async () => {
    git('rm', '-q', 'PROGRESS.md'); git('commit', '-qm', 'No progress document yet');
    const report: SpecReviewReport = { complete: true, checksObserved: true, summary: 'Checks observed.', gaps: [], sections: [{ section: 'Recovery', status: 'done', evidence: 'Probe passed' }] };
    const receipt = await publishSpecReviewProgress(input({ report }));
    expect(read()).toContain('Agent-reported result: spec complete; checks observed; sections 1/1 done');
    expect(read()).toContain(`report ${receipt.reportDigest.slice(0, 8)}`);
    expect(read()).toContain('not owner acceptance');
  });

  it('bounds repeated target movement and leaves the checkout document untouched', async () => {
    const contents = read(); let movement = 0;
    vi.spyOn(autonomousGit, 'advanceBranch').mockImplementation(async () => {
      commit('source.ts', `concurrent edit ${++movement}\n`);
      return 'target moved';
    });
    await expect(publishSpecReviewProgress(input())).rejects.toThrow(/kept moving/);
    expect(movement).toBe(3); expect(read()).toBe(contents); expect(git('status', '--porcelain')).toBe('');
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('preserves authored bytes around the sole block, escapes injected markup, and fits a near-limit snapshot', () => {
    const report = pending(); report.summary = '<!--wb:review-->\n<script>unsafe</script>'; report.gaps[0].title = '<!--/wb:review-->';
    const rendered = renderSpecReviewProgress('prefix\r\n', input({ report }));
    expect(rendered).toContain('&lt;!--wb:review--&gt;'); expect(rendered).not.toContain('<script>');
    const surrounded = `${rendered}Authored suffix without newline`;
    const replaced = renderSpecReviewProgress(surrounded, input({ reviewedAt: '2026-10-30T14:21:00.000Z' }));
    expect(replaced.startsWith('prefix\r\n')).toBe(true); expect(replaced.endsWith('Authored suffix without newline')).toBe(true);
    const authored = 'x'.repeat(5970) + '\n';
    const compact = renderSpecReviewProgress(authored, input());
    expect(compact.startsWith(authored)).toBe(true); expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(6144);
    expect(compact).toContain('Review #024 r3'); expect(compact).toContain('@aaaaaaaaaaaa'); expect(compact).toContain('incomplete; 1 gaps; checks unobserved'); expect(compact).toContain('Not acceptance');
    expect(() => renderSpecReviewProgress('x'.repeat(6130), input())).toThrow(/compact the authored snapshot/);
  });

  it('fails safely on a dirty canonical document, a symlink, malformed markers and an oversized authored snapshot', async () => {
    const base = git('rev-parse', 'HEAD');
    write('PROGRESS.md', 'Uncommitted owner evidence\n'); git('add', 'PROGRESS.md'); write('PROGRESS.md', 'Further owner evidence\n');
    const status = git('status', '--porcelain'); const staged = git('diff', '--cached');
    await expect(publishSpecReviewProgress(input())).rejects.toThrow(/without overwriting checkout work/);
    expect(git('rev-parse', 'HEAD')).toBe(base); expect(git('status', '--porcelain')).toBe(status); expect(git('diff', '--cached')).toBe(staged); expect(read()).toBe('Further owner evidence\n');
    // Finish this fixture's owner edit before testing independently invalid tracked snapshots.
    git('add', 'PROGRESS.md'); git('commit', '-qm', 'Owner evidence');
    write('target.txt', 'immutable target'); git('add', 'target.txt'); git('commit', '-qm', 'Target');
    rmSync(path.join(project, 'PROGRESS.md')); symlinkSync('target.txt', path.join(project, 'PROGRESS.md')); git('add', 'PROGRESS.md'); git('commit', '-qm', 'Symlink');
    await expect(publishSpecReviewProgress(input())).rejects.toThrow(/regular file/); expect(read('target.txt')).toBe('immutable target');
    rmSync(path.join(project, 'PROGRESS.md')); commit('PROGRESS.md', `${SPEC_REVIEW_PROGRESS_START}\nmissing end\n`);
    await expect(publishSpecReviewProgress(input())).rejects.toThrow(/Malformed/);
    commit('PROGRESS.md', 'x'.repeat(6145));
    await expect(publishSpecReviewProgress(input())).rejects.toThrow(/exceeds 6 KiB/);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('does not touch the checkout when committing fails, and rejects malformed reports before writing', async () => {
    const base = git('rev-parse', 'HEAD'); const contents = read();
    git('config', 'commit.gpgsign', 'true'); git('config', 'gpg.program', '/workbench-test/missing-gpg');
    await expect(publishSpecReviewProgress(input())).rejects.toThrow();
    expect(git('rev-parse', 'HEAD')).toBe(base); expect(read()).toBe(contents); expect(git('status', '--porcelain')).toBe('');
    await expect(publishSpecReviewProgress(input({ report: { ...pending(), complete: true } }))).rejects.toThrow(/claims completion/);
    expect(() => renderSpecReviewProgress(`${SPEC_REVIEW_PROGRESS_END}${SPEC_REVIEW_PROGRESS_START}`, input())).toThrow(/Malformed/);
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it.each(['source.ts', 'PROGRESS.md'])('rejects a commit hook that changes %s beyond the rendered contract', async (file) => {
    write('source.ts', 'staged owner edit\n'); git('add', 'source.ts'); write('source.ts', 'dirty owner edit\n');
    const base = git('rev-parse', 'HEAD'); const progress = read(); const staged = git('diff', '--cached'); const dirty = git('diff');
    const hook = path.join(project, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\nprintf 'hook rewrite\\n' > '${file}'\ngit add -- '${file}'\n`); chmodSync(hook, 0o755);
    await expect(publishSpecReviewProgress(input())).rejects.toThrow(/check repository commit hooks/);
    expect(git('rev-parse', 'HEAD')).toBe(base); expect(read()).toBe(progress);
    expect(git('diff', '--cached')).toBe(staged); expect(git('diff')).toBe(dirty);
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('honors cancellation without publishing or leaving an owned temporary worktree', async () => {
    const base = git('rev-parse', 'HEAD'); const controller = new AbortController(); controller.abort();
    await expect(publishSpecReviewProgress(input({ signal: controller.signal }))).rejects.toThrow();
    expect(git('rev-parse', 'HEAD')).toBe(base); expect(git('status', '--porcelain')).toBe('');
    expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });
});
