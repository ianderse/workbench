/**
 * An agent window's header follows the session its Claude Code turns to by itself (/resume,
 * /clear, claude --resume): the session is recorded as the window's own, the worktree follows
 * where it runs, and the renderer is told the session
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { IPC_CHANNELS } from '../../../shared/constants';
import type { OtherWorktreeInfo, TerminalWorktreeConfig } from '../../../shared/types';
import { recordAgentSession } from '../../agent-session-store';
import { createWindowSessionTracker, type WindowSessionDeps } from '../window-session';
import type { TerminalProcess } from '../types';

vi.mock('../../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const OLD_SESSION = '11111111-1111-4111-8111-111111111111';
const NEW_SESSION = '22222222-2222-4222-8222-222222222222';

describe('window session tracker', () => {
  let root: string;
  let project: string;
  let claudeDir: string;
  let terminal: TerminalProcess;
  let otherWorktrees: OtherWorktreeInfo[];
  let deps: {
    getTerminal: WindowSessionDeps['getTerminal'];
    setWorktreeConfig: ReturnType<typeof vi.fn<WindowSessionDeps['setWorktreeConfig']>>;
    send: ReturnType<typeof vi.fn<WindowSessionDeps['send']>>;
    recordSession: ReturnType<typeof vi.fn<WindowSessionDeps['recordSession']>>;
    listOtherWorktrees: ReturnType<typeof vi.fn<WindowSessionDeps['listOtherWorktrees']>>;
    claudeConfigDirs: WindowSessionDeps['claudeConfigDirs'];
    wait: WindowSessionDeps['wait'];
  };

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'window-session-')));
    project = path.join(root, 'project');
    claudeDir = path.join(root, 'claude');
    mkdirSync(path.join(project, '.workbench'), { recursive: true });
    mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
    terminal = { id: 'term-1', projectPath: project, cwd: project, title: 'Claude' } as TerminalProcess;
    otherWorktrees = [];
    deps = {
      getTerminal: (id) => (id === terminal.id ? terminal : undefined),
      setWorktreeConfig: vi.fn<WindowSessionDeps['setWorktreeConfig']>((_id, config) => {
        terminal.worktreeConfig = config;
      }),
      send: vi.fn<WindowSessionDeps['send']>(),
      recordSession: vi.fn<WindowSessionDeps['recordSession']>(async () => undefined),
      listOtherWorktrees: vi.fn<WindowSessionDeps['listOtherWorktrees']>(async () => otherWorktrees),
      claudeConfigDirs: () => [claudeDir],
      wait: async () => undefined,
    };
    // The window's own session, as Workbench recorded it when it started the window
    await recordAgentSession(project, { sessionId: OLD_SESSION, terminalId: terminal.id, cwd: project, startedAt: '2026-10-20T09:00:00.000Z' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The window's Claude Code turning to a session in place (`/resume`) */
  const resumed = { event: 'SessionStart' as const, source: 'resume' };

  const registry = (pid: number, sessionId: string, kind: string) =>
    writeFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: project, kind }));

  const sessionChanges = () =>
    deps.send.mock.calls.filter((call) => call[0] === IPC_CHANNELS.TERMINAL_CLAUDE_SESSION_CHANGE).map((call) => call.slice(1));
  const worktreeChanges = () =>
    deps.send.mock.calls.filter((call) => call[0] === IPC_CHANNELS.TERMINAL_WORKTREE_CONFIG_CHANGE).map((call) => call.slice(1));

  it('records a session the window turned to as its own and tells the renderer', async () => {
    registry(100, NEW_SESSION, 'interactive');
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.recordSession).toHaveBeenCalledWith(terminal, NEW_SESSION, project);
    expect(sessionChanges()).toEqual([[terminal.id, NEW_SESSION]]);
    // The project itself, as before: the worktree stays none
    expect(deps.setWorktreeConfig).not.toHaveBeenCalled();
  });

  it('trusts a session resumed in place, whether the registry lists it yet or not', async () => {
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.recordSession).toHaveBeenCalledWith(terminal, NEW_SESSION, project);
  });

  it('takes a session a new process started only once the registry has it running in a terminal', async () => {
    // `claude -p` run by the agent in the window inherits the window's id and starts like this,
    // but never runs in a terminal
    const track = createWindowSessionTracker(deps);
    await track({ terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project, event: 'SessionStart', source: 'startup' });
    expect(deps.recordSession).not.toHaveBeenCalled();
    expect(sessionChanges()).toEqual([]);

    registry(400, NEW_SESSION, 'interactive');
    await createWindowSessionTracker(deps)({ terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project, event: 'SessionStart', source: 'startup' });
    expect(deps.recordSession).toHaveBeenCalledWith(terminal, NEW_SESSION, project);
  });

  it('takes a prompt only from a session running in a terminal', async () => {
    const track = createWindowSessionTracker(deps);
    await track({ terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project, event: 'UserPromptSubmit' });
    expect(deps.recordSession).not.toHaveBeenCalled();

    registry(500, NEW_SESSION, 'interactive');
    await createWindowSessionTracker(deps)({ terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project, event: 'UserPromptSubmit' });
    expect(deps.recordSession).toHaveBeenCalled();
  });

  it('pays no heed to where a prompt was given: the agent may have moved its shell there', async () => {
    registry(600, NEW_SESSION, 'interactive');
    const worktree = path.join(project, '.workbench', 'worktrees', 'tasks', '005-elsewhere');
    const track = createWindowSessionTracker(deps);

    await track({ terminalId: terminal.id, sessionId: NEW_SESSION, cwd: worktree, event: 'UserPromptSubmit' });

    expect(deps.setWorktreeConfig).not.toHaveBeenCalled();
    // Recorded where the window runs, not where the agent last went
    expect(deps.recordSession).toHaveBeenCalledWith(terminal, NEW_SESSION, terminal.cwd);
  });

  it('does not record the session the window already has', async () => {
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: OLD_SESSION, cwd: project });

    expect(deps.recordSession).not.toHaveBeenCalled();
    expect(sessionChanges()).toEqual([[terminal.id, OLD_SESSION]]);
  });

  it('ignores a background session that inherited the window\'s terminal id', async () => {
    registry(200, NEW_SESSION, 'bg');
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.recordSession).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('counts a session run in a terminal even with a stale background entry for it', async () => {
    registry(200, NEW_SESSION, 'bg');
    registry(300, NEW_SESSION, 'interactive');
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.recordSession).toHaveBeenCalled();
  });

  it('ignores windows that have no project', async () => {
    terminal.projectPath = undefined;
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.recordSession).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('shows the task worktree a session runs in, without moving the window', async () => {
    const worktree = path.join(project, '.workbench', 'worktrees', 'tasks', '001-feature');
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: path.join(worktree, 'src') });

    expect(terminal.worktreeConfig).toMatchObject({
      name: '001-feature',
      worktreePath: worktree,
      branchName: 'workbench/001-feature',
      hasGitBranch: true,
      terminalId: terminal.id,
    });
    expect(worktreeChanges()).toEqual([[terminal.id, terminal.worktreeConfig]]);
    expect(terminal.cwd).toBe(project);
  });

  it('shows a window worktree with the config it was made with', async () => {
    const worktree = path.join(project, '.workbench', 'worktrees', 'terminal', 'spike');
    const stored: TerminalWorktreeConfig = {
      name: 'spike', worktreePath: worktree, branchName: 'terminal/spike', baseBranch: 'main',
      hasGitBranch: true, createdAt: '2026-10-01T00:00:00.000Z', terminalId: 'term-0',
    };
    mkdirSync(path.join(project, '.workbench', 'terminal', 'metadata'), { recursive: true });
    writeFileSync(path.join(project, '.workbench', 'terminal', 'metadata', 'spike.json'), JSON.stringify(stored));
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: worktree });

    expect(terminal.worktreeConfig).toEqual(stored);
  });

  it('shows a worktree Workbench did not make', async () => {
    const worktree = path.join(project, '.claude', 'worktrees', 'quick-fix');
    otherWorktrees = [{ path: worktree, branch: 'quick-fix', commitSha: 'abc1234', displayName: 'quick-fix' }];
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: worktree });

    expect(terminal.worktreeConfig).toMatchObject({ name: 'quick-fix', worktreePath: worktree, branchName: 'quick-fix', hasGitBranch: true });
  });

  it('leaves the worktree shown when the session runs in the project itself', async () => {
    // A restored worktree window resumes its session from the project's folder: that must not
    // take its worktree off
    terminal.worktreeConfig = {
      name: '001-feature', worktreePath: path.join(project, '.workbench', 'worktrees', 'tasks', '001-feature'),
      branchName: 'workbench/001-feature', baseBranch: '', hasGitBranch: true, createdAt: '', terminalId: terminal.id,
    };
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.setWorktreeConfig).not.toHaveBeenCalled();
    expect(worktreeChanges()).toEqual([]);
    // The session is still followed
    expect(deps.recordSession).toHaveBeenCalled();
  });

  it('keeps the worktree shown when the session runs in it already', async () => {
    const worktree = path.join(project, '.workbench', 'worktrees', 'tasks', '001-feature');
    const current: TerminalWorktreeConfig = {
      name: '001-feature', worktreePath: worktree, branchName: 'workbench/001-feature', baseBranch: 'main',
      hasGitBranch: true, taskId: 'task-1', createdAt: '', terminalId: terminal.id,
    };
    terminal.worktreeConfig = current;
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: worktree });

    expect(deps.setWorktreeConfig).not.toHaveBeenCalled();
    expect(terminal.worktreeConfig).toBe(current);
  });

  it('leaves the worktree alone for a session run outside the project', async () => {
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: path.join(root, 'elsewhere') });

    expect(deps.setWorktreeConfig).not.toHaveBeenCalled();
    expect(sessionChanges()).toEqual([[terminal.id, NEW_SESSION]]);
  });

  it('does nothing for the same session reported again (every prompt reports it)', async () => {
    const track = createWindowSessionTracker(deps);

    await Promise.all([
      track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project }),
      track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project }),
    ]);
    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });

    expect(deps.recordSession).toHaveBeenCalledTimes(1);
    expect(sessionChanges()).toEqual([[terminal.id, NEW_SESSION]]);
  });

  it('follows the window back to a session it had before', async () => {
    const track = createWindowSessionTracker(deps);

    await track({ ...resumed, terminalId: terminal.id, sessionId: NEW_SESSION, cwd: project });
    await track({ ...resumed, terminalId: terminal.id, sessionId: OLD_SESSION, cwd: project });

    expect(sessionChanges()).toEqual([[terminal.id, NEW_SESSION], [terminal.id, OLD_SESSION]]);
  });
});
