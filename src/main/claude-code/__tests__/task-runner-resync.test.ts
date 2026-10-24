/**
 * Resync runs (real git worktree, scripted Claude Code): the task's own session merges the base
 * branch another task was merged into, resumes where it stopped, and validates; Workbench checks
 * the merge, gives the session one more pass when it finds problems, and fails the run when they
 * remain. Any failure marks the request failed (no automatic restart); a merge that never passed
 * the check is checked (and validated) on the next start; a change request is applied first.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeProcessOptions } from '../process';
import type { ClaudeStreamMessage } from '../stream-types';
import type { ClaudeRunInfo, TaskTriage } from '../../../shared/types/claude-code';
import { DEFAULT_CLAUDE_CODE_TASK_SETTINGS } from '../../../shared/types/claude-code';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../cli-tool-manager', () => ({ getToolPath: () => 'git', getToolPathAsync: async () => 'git' }));
vi.mock('../env', () => ({
  resolveClaudeEnv: vi.fn(async (options?: { extraEnv?: Record<string, string> }) => ({ command: 'claude', env: { ...(options?.extraEnv ?? {}) } })),
}));

/** One entry per spawned process: what the session does in the worktree, then its stream */
type Script = { effect?: () => void; messages: ClaudeStreamMessage[] };
const scripts: Script[] = [];
const spawned: ClaudeProcessOptions[] = [];

vi.mock('../process', () => ({
  INITIAL_INPUT_ID: 'initial',
  startClaudeProcess: vi.fn((options: ClaudeProcessOptions) => {
    spawned.push(options);
    const script = scripts.shift() ?? { messages: [] };
    script.effect?.();
    const results: ClaudeStreamMessage[] = [];
    for (const message of script.messages) {
      if (message.type === 'result') results.push(message);
      options.onMessage?.(message);
    }
    return {
      child: {},
      stop: vi.fn(),
      send: vi.fn(() => false),
      done: Promise.resolve({ exitCode: 0, signal: null, result: results.at(-1), results, unread: [], stderr: '', aborted: false, timedOut: false }),
    };
  }),
}));
vi.mock('../../platform/shell-runtime', () => ({
  whenShellRuntimeReady: async () => ({}),
  getWslInfo: () => null,
  toHostPath: (p: string) => p,
  toRuntimePath: (p: string) => p,
}));

vi.mock('../../ai/runners/merge-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ai/runners/merge-agent')>()),
  runMergeAgent: vi.fn(),
}));

import { ClaudeTaskRun, loadClaudeRunInfo } from '../task-runner';
import { runMergeAgent } from '../../ai/runners/merge-agent';
import { readResyncRequest, recordResyncRequest, updateResyncRequest, type ResyncRequest } from '../../task-resync/request';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const commitFile = (repo: string, file: string, content: string, message: string) => {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
};

function result(fields: Record<string, unknown> = {}): ClaudeStreamMessage {
  return { type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'Done', total_cost_usd: 0.1, num_turns: 1, duration_ms: 10, ...fields } as ClaudeStreamMessage;
}
const validated = () => result({ structured_output: { status: 'passed', summary: 'Still works', checks: [], findings: [] } });

const triage: TaskTriage = {
  model: 'sonnet', effort: 'medium', needsPlan: false, scope: 'small', title: 'Task B',
  reasoning: '', verification: ['npm test'], source: 'auto',
};

function promptOf(index: number): string {
  const input = spawned[index].input as Array<{ type: string; text?: string }>;
  return input.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
const argValue = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('ClaudeTaskRun resync', () => {
  let tmp: string;
  let root: string;
  let worktree: string;
  let specDir: string;

  beforeEach(() => {
    scripts.length = 0;
    spawned.length = 0;
    tmp = mkdtempSync(path.join(tmpdir(), 'resync-run-'));
    root = path.join(tmp, 'project');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    commitFile(root, 'a.txt', 'one\ntwo\nthree\n', 'base');
    worktree = path.join(tmp, 'wt');
    git(root, 'worktree', 'add', '-q', '-b', 'workbench/002-b', worktree, 'main');
    commitFile(worktree, 'b.txt', 'task b\n', 'task b work');
    specDir = path.join(root, '.workbench', 'tasks', '002-b');
    mkdirSync(specDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runInfo(phases: ClaudeRunInfo['phases'], sessionId: string | null = 's1'): void {
    const info: ClaudeRunInfo = { version: 1, phases, subagents: [], totalCostUsd: 0, updatedAt: new Date().toISOString(), triage, sessionId: sessionId ?? undefined, runtime: 'native' };
    writeFileSync(path.join(specDir, 'claude_run.json'), JSON.stringify(info));
  }
  const done = (name: ClaudeRunInfo['phases'][number]['name'], extra = {}) =>
    ({ name, startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z', sessionId: 's1', ...extra });

  /** Task 001-a merged into main: `c.txt`, or a change to `a.txt` */
  function mergeIntoMain(change: 'c' | 'a' = 'c'): ResyncRequest {
    if (change === 'c') commitFile(root, 'c.txt', 'from task a\n', 'task a merged');
    else commitFile(root, 'a.txt', 'one\nTWO FROM A\nthree\nfour from a\n', 'task a merged');
    return recordResyncRequest(specDir, { ref: 'main', into: 'main', via: 'local', merged: { specId: '001-a', title: 'A', files: [change === 'c' ? 'c.txt' : 'a.txt'] } });
  }

  function makeRun(request: ResyncRequest | undefined, callbacks = {}, overrides: Record<string, unknown> = {}) {
    return new ClaudeTaskRun({
      taskId: '002-b', projectId: 'p1', specId: '002-b', specDir, worktreePath: worktree, branch: 'workbench/002-b',
      baseBranch: 'main', title: 'Task B', description: 'Do B', attachments: [], connectorIds: [],
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS }, mode: 'start', ...(request ? { resync: request } : {}), ...overrides,
    }, callbacks);
  }

  it("merges in the task's own session, keeps a finished task's work as it is, and validates again", async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    scripts.push(
      { effect: () => git(worktree, 'merge', '--no-edit', 'main'), messages: [result({ result: 'Merged main, no conflicts' })] },
      { messages: [validated()] },
    );
    const events: string[] = [];
    const progress: Array<{ message: string; syncingWith?: string }> = [];
    const outcome = await makeRun(request, {
      onTaskEvent: (type: string) => events.push(type),
      onProgress: (p: { message: string; syncingWith?: string }) => progress.push(p),
    }).run();

    expect(outcome.status).toBe('completed');
    expect(events).toEqual(['CODING_STARTED', 'QA_STARTED', 'QA_PASSED']);
    expect(progress[0]).toEqual(expect.objectContaining({ message: 'Syncing with main', syncingWith: 'main' }));
    // The same session, with the implementation's permissions and model
    expect(argValue(spawned[0].args, '--resume')).toBe('s1');
    expect(spawned[0].args).toContain('--dangerously-skip-permissions');
    expect(argValue(spawned[0].args, '--model')).toBe('sonnet');
    const prompt = promptOf(0);
    expect(prompt).toMatch(/^Your base branch moved on: other work was merged into `main`/);
    expect(prompt).toContain('- task 001-a "A" (changed `c.txt`)');
    expect(prompt).toContain('Run `git merge --no-edit main`');
    expect(prompt).toContain('Your work on this task was already done before');
    expect(promptOf(1)).toContain('Before handing this off, validate the work:');

    const info = loadClaudeRunInfo(specDir)!;
    expect(info.phases.map((p) => p.name)).toEqual(['triage', 'implement', 'validate', 'resync', 'validate']);
    expect(info.phases[3].resync).toEqual({ ref: 'main', into: 'main', continued: false });
    expect(readResyncRequest(specDir)).toBeUndefined();
    expect(existsSync(path.join(worktree, 'c.txt'))).toBe(true);
  });

  it('carries on with an implementation that was stopped, in the same turn', async () => {
    runInfo([done('triage'), done('implement', { isError: true, error: 'Stopped' })]);
    const request = mergeIntoMain();
    scripts.push(
      { effect: () => git(worktree, 'merge', '--no-edit', 'main'), messages: [result({ result: 'Merged and finished B' })] },
      { messages: [validated()] },
    );
    const outcome = await makeRun(request).run();

    expect(outcome.status).toBe('completed');
    // No separate implementation step: the resync carried on with it
    expect(spawned).toHaveLength(2);
    expect(promptOf(0)).toContain('Then continue the task from where you left off');
    const info = loadClaudeRunInfo(specDir)!;
    expect(info.phases.map((p) => p.name)).toEqual(['triage', 'implement', 'resync', 'validate']);
    expect(info.phases[2].resync?.continued).toBe(true);
    expect(info.summary).toBe('Still works');
  });

  it('gives the session one more pass when its merge lost changes from the base branch', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    commitFile(worktree, 'a.txt', 'one\nTWO FROM B\nthree\n', 'task b changes a');
    const request = mergeIntoMain('a');
    scripts.push(
      // Resolves the conflict by keeping only its own side: main's new lines are lost
      { effect: () => {
        try { git(worktree, 'merge', '--no-edit', 'main'); } catch { /* conflicts */ }
        writeFileSync(path.join(worktree, 'a.txt'), 'one\nTWO FROM B\nthree\n');
        git(worktree, 'commit', '-q', '-am', 'merge main');
      }, messages: [result()] },
      // Restores main's line, and says why its version of line two must go
      { effect: () => {
        writeFileSync(path.join(worktree, 'a.txt'), 'one\nTWO FROM B\nthree\nfour from a\n');
        git(worktree, 'commit', '-q', '-am', 'restore');
      }, messages: [result({ structured_output: { summary: 'Restored', intentionallyDropped: [{ file: 'a.txt', line: 'TWO FROM A', reason: 'B replaces it' }] } })] },
      { messages: [validated()] },
    );
    const outcome = await makeRun(request).run();

    expect(outcome.status).toBe('completed');
    const fix = promptOf(1);
    expect(fix).toMatch(/^Workbench checked your merge and found problems:/);
    expect(fix).toContain('The merge lost changes from `main` in a.txt');
    expect(fix).toContain('    four from a');
    expect(argValue(spawned[1].args, '--json-schema')).toContain('intentionallyDropped');
    expect(loadClaudeRunInfo(specDir)!.phases.map((p) => p.name)).toEqual(['triage', 'implement', 'validate', 'resync', 'resync', 'validate']);
    expect(readResyncRequest(specDir)).toBeUndefined();
  });

  it('fails the run into review with the reason when the merge is still not right, and does not retry it on its own', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    scripts.push({ messages: [result()] }, { messages: [result({ structured_output: { summary: 'Tried', intentionallyDropped: [] } })] });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const outcome = await makeRun(request, { onTaskEvent: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }) }).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/^Could not sync this task with main: `main` is not merged into the branch/);
    expect(events.at(-1)).toEqual({ type: 'CODING_FAILED', payload: expect.objectContaining({ error: outcome.error }) });
    expect(spawned).toHaveLength(2);
    const info = loadClaudeRunInfo(specDir)!;
    expect(info.phases.slice(-2).map((p) => [p.name, p.isError])).toEqual([['resync', true], ['resync', true]]);
    expect(readResyncRequest(specDir)).toEqual(expect.objectContaining({ failedAt: expect.any(String), error: outcome.error }));
  });

  it('skips the merge when the branch already has it', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    git(worktree, 'merge', '--no-edit', 'main');
    const outcome = await makeRun(request).run();

    expect(outcome.status).toBe('completed');
    expect(spawned).toHaveLength(0);
    expect(readResyncRequest(specDir)).toBeUndefined();
  });

  it('keeps the request when the session hits a usage limit, so the resumed run applies it', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    scripts.push({ messages: [result({ is_error: true, subtype: 'error_during_execution', api_error_status: 429, result: 'Rate limited' })] });
    const events: string[] = [];
    const outcome = await makeRun(request, { onTaskEvent: (type: string) => events.push(type) }).run();

    expect(outcome.status).toBe('rate_limited');
    expect(events).toContain('RATE_LIMIT_HOLD');
    expect(readResyncRequest(specDir)?.at).toBe(request.at);
  });

  it('leaves a newer request for the next run', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    scripts.push(
      { effect: () => {
        git(worktree, 'merge', '--no-edit', 'main');
        // Another task merged into main while this one synced
        recordResyncRequest(specDir, { ref: 'main', into: 'main', via: 'local', merged: { specId: '009-z', files: [] } }, new Date(Date.now() + 1000));
      }, messages: [result()] },
      { messages: [validated()] },
    );
    await makeRun(request).run();
    expect(readResyncRequest(specDir)?.merged.map((t) => t.specId)).toEqual(['001-a', '009-z']);
  });

  it('merges with the merge helper when the task has no session, then implements and validates', async () => {
    runInfo([done('triage')], null);
    const request = mergeIntoMain();
    let merged = false;
    scripts.push(
      { effect: () => { merged = existsSync(path.join(worktree, 'c.txt')); }, messages: [result()] },
      { messages: [validated()] },
    );
    const outcome = await makeRun(request).run();

    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe('completed');
    expect(merged).toBe(true);
    expect(spawned[0].args).toContain('--session-id');
    expect(loadClaudeRunInfo(specDir)!.phases.map((p) => p.name)).toEqual(['triage', 'resync', 'implement', 'validate']);
    expect(readFileSync(path.join(worktree, 'c.txt'), 'utf-8')).toBe('from task a\n');
    expect(readResyncRequest(specDir)).toBeUndefined();
  });

  /** The session merges main into its branch and resolves a.txt keeping only its own side */
  const mergeKeepingOurs = () => {
    try { git(worktree, 'merge', '--no-edit', 'main'); } catch { /* conflicts */ }
    writeFileSync(path.join(worktree, 'a.txt'), 'one\nTWO FROM B\nthree\n');
    git(worktree, 'commit', '-q', '-am', 'merge main');
  };
  const failedResult = (error = 'No conversation found with session ID: s1') =>
    result({ is_error: true, subtype: 'error_during_execution', errors: [error], result: undefined });

  it('marks the request failed when the resync step itself fails, so nothing restarts the task for it', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    scripts.push({ messages: [failedResult()] });
    const outcome = await makeRun(request).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('No conversation found');
    expect(readResyncRequest(specDir)).toEqual(expect.objectContaining({ failedAt: expect.any(String), error: outcome.error }));
  });

  it('checks a merge an earlier resync committed but never got through the check, then validates again', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    commitFile(worktree, 'a.txt', 'one\nTWO FROM B\nthree\n', 'task b changes a');
    const request = mergeIntoMain('a');
    const mainCommit = git(root, 'rev-parse', 'main');
    // The session merges, losing main's lines; its fix pass ends in an error
    scripts.push({ effect: mergeKeepingOurs, messages: [result()] }, { messages: [failedResult('boom')] });
    expect((await makeRun(request).run()).status).toBe('failed');
    const failed = readResyncRequest(specDir)!;
    expect(failed.failedAt).toBeDefined();
    expect(failed.unverified).toEqual([{ ref: 'main', commit: mainCommit }]);

    // The user starts it again: the branch has main, yet the merge is checked, fixed and validated
    spawned.length = 0;
    scripts.push(
      { effect: () => {
        writeFileSync(path.join(worktree, 'a.txt'), 'one\nTWO FROM B\nthree\nfour from a\n');
        git(worktree, 'commit', '-q', '-am', 'restore');
      }, messages: [result({ structured_output: { summary: 'Restored', intentionallyDropped: [{ file: 'a.txt', line: 'TWO FROM A', reason: 'B replaces it' }] } })] },
      { messages: [validated()] },
    );
    const outcome = await makeRun(failed).run();

    expect(outcome.status).toBe('completed');
    expect(spawned).toHaveLength(2);
    expect(promptOf(0)).toMatch(/^Workbench checked your merge and found problems:/);
    expect(promptOf(1)).toContain('Before handing this off, validate the work:');
    expect(readResyncRequest(specDir)).toBeUndefined();
  });

  it('validates again after a resync that merged but ended in an error', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain();
    scripts.push({ effect: () => git(worktree, 'merge', '--no-edit', 'main'), messages: [failedResult('boom')] });
    expect((await makeRun(request).run()).status).toBe('failed');

    spawned.length = 0;
    scripts.push({ messages: [validated()] });
    const outcome = await makeRun(readResyncRequest(specDir)).run();

    expect(outcome.status).toBe('completed');
    expect(spawned).toHaveLength(1);
    expect(promptOf(0)).toContain('Before handing this off, validate the work:');
    expect(readResyncRequest(specDir)).toBeUndefined();
  });

  it("checks the files of work the session committed right before merging as the task's side", async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const request = mergeIntoMain('a');
    // Uncommitted work of the task, committed by the session as the prompt asks, then merged
    writeFileSync(path.join(worktree, 'a.txt'), 'one\nTWO FROM B\nthree\n');
    scripts.push(
      { effect: () => { git(worktree, 'commit', '-q', '-am', 'wip'); mergeKeepingOurs(); }, messages: [result()] },
      { messages: [result({ structured_output: { summary: 'Tried', intentionallyDropped: [] } })] },
    );
    const outcome = await makeRun(request).run();

    expect(outcome.status).toBe('failed');
    expect(promptOf(1)).toContain('The merge lost changes from `main` in a.txt');
    expect(outcome.error).toContain('The merge lost changes from `main` in a.txt');
  });

  it("applies requested changes before a pending sync, and keeps them when the sync fails again", async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    const pending = mergeIntoMain();
    updateResyncRequest(specDir, pending.at, { failedAt: new Date().toISOString(), error: 'earlier failure' });
    scripts.push(
      { effect: () => commitFile(worktree, 'b.txt', 'task b, blue\n', 'blue'), messages: [result({ result: 'Made it blue' })] },
      { messages: [failedResult('boom')] },
    );
    const outcome = await makeRun(readResyncRequest(specDir), {}, {
      mode: 'revise',
      feedback: 'Make the button blue',
      settings: { ...DEFAULT_CLAUDE_CODE_TASK_SETTINGS, triage: 'fixed' },
    }).run();

    expect(promptOf(0)).toContain('Make the button blue');
    expect(promptOf(1)).toMatch(/^Your base branch moved on/);
    expect(outcome.status).toBe('failed');
    expect(readFileSync(path.join(worktree, 'b.txt'), 'utf-8')).toBe('task b, blue\n');
    expect(loadClaudeRunInfo(specDir)!.phases.map((p) => p.name)).toEqual(['triage', 'implement', 'validate', 'triage', 'revise', 'resync']);
  });

  it('merges every ref the request names, and checks each', async () => {
    runInfo([done('triage'), done('implement'), done('validate')]);
    mergeIntoMain();
    // A ref main does not have (as origin/main can be after a merged pull request)
    git(root, 'checkout', '-q', '-b', 'side', 'main~1');
    commitFile(root, 'd.txt', 'from side\n', 'side work');
    git(root, 'checkout', '-q', 'main');
    const request = recordResyncRequest(specDir, { ref: 'side', into: 'main', via: 'pr', merged: { specId: '009-z', files: ['d.txt'] } });
    expect(request).toEqual(expect.objectContaining({ ref: 'side', refs: ['main', 'side'], via: 'local' }));
    scripts.push(
      // Merges only one of them: the check sends it back for the other
      { effect: () => git(worktree, 'merge', '--no-edit', 'main'), messages: [result()] },
      { effect: () => git(worktree, 'merge', '--no-edit', 'side'), messages: [result({ structured_output: { summary: 'Merged side', intentionallyDropped: [] } })] },
      { messages: [validated()] },
    );
    const outcome = await makeRun(request).run();

    expect(outcome.status).toBe('completed');
    expect(promptOf(0)).toContain('Run `git merge --no-edit main`, then `git merge --no-edit side`');
    expect(promptOf(1)).toContain('`side` is not merged into the branch');
    expect(readResyncRequest(specDir)).toBeUndefined();
  });

  it('lets Stop interrupt the merge helper of a task without a session', async () => {
    runInfo([done('triage')], null);
    commitFile(worktree, 'a.txt', 'one\nTWO FROM B\nthree\n', 'task b changes a');
    const request = mergeIntoMain('a');
    const before = git(worktree, 'rev-parse', 'HEAD');
    let run: ClaudeTaskRun | undefined;
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(runMergeAgent).mockImplementationOnce(async (input) => {
      signals.push(input.abortSignal);
      run!.stop();
      return { status: 'failed', summary: 'Stopped', intentionallyDropped: [] };
    });
    run = makeRun(request);
    const outcome = await run.run();

    expect(outcome.status).toBe('stopped');
    expect(signals[0]?.aborted).toBe(true);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(readResyncRequest(specDir)?.failedAt).toBeUndefined();
  });
});
