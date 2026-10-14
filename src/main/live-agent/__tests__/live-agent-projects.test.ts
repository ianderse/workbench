/**
 * The per-project "Live agent" setting: on while the project's .auto-claude/flow directory exists.
 * Switching it on creates that directory and runs the setup (hook script, Claude Code hooks in
 * .claude/settings.local.json); switching it off undoes both. The relay runs while any project has it on.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { projects, setEnabled, dropProject } = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; path: string }>,
  setEnabled: vi.fn(),
  dropProject: vi.fn(),
}));

vi.mock('../../project-store', () => ({ projectStore: { getProjects: () => projects } }));
vi.mock('../live-agent-relay', () => ({ liveAgentRelay: { setEnabled, dropProject } }));
vi.mock('../../app-logger', () => ({
  appLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import {
  isKnownProject,
  isLiveAgentEnabled,
  setLiveAgentEnabled,
  syncLiveAgentAtStartup,
} from '../live-agent-projects';
import { addToWorktree } from '../project-setup';

const HOOK_EVENTS = ['PreToolUse', 'Notification', 'Stop', 'SessionEnd', 'SubagentStop'];

describe('Live agent per project', () => {
  let root: string;
  let projectA: string;
  let projectB: string;
  const settingsFile = (project: string) => path.join(project, '.claude', 'settings.local.json');
  const readSettings = (project: string) => JSON.parse(fs.readFileSync(settingsFile(project), 'utf-8'));
  const flowDir = (project: string) => path.join(project, '.auto-claude', 'flow');

  beforeEach(() => {
    setEnabled.mockClear();
    dropProject.mockClear();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-projects-')));
    projectA = path.join(root, 'a');
    projectB = path.join(root, 'b');
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    projects.splice(0, projects.length, { id: 'a', path: projectA }, { id: 'b', path: projectB });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is off for a project without a flow directory, and only known projects count', async () => {
    expect(await isLiveAgentEnabled(projectA)).toBe(false);
    expect(isKnownProject(projectA)).toBe(true);
    expect(isKnownProject(path.join(root, 'elsewhere'))).toBe(false);
  });

  it('switching on creates the flow directory, sets up the hooks and starts the relay', async () => {
    fs.mkdirSync(path.dirname(settingsFile(projectA)));
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    fs.writeFileSync(settingsFile(projectA), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [userHook] } }));

    expect(await setLiveAgentEnabled(projectA, true)).toEqual({});
    expect(setEnabled).toHaveBeenCalledWith(true);

    // The setting is stored with the project: read again (as after a restart) it is on
    expect(await isLiveAgentEnabled(projectA)).toBe(true);
    expect(fs.existsSync(path.join(flowDir(projectA), 'hook.cjs'))).toBe(true);

    const settings = readSettings(projectA);
    expect(settings.model).toBe('opus');
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(settings.hooks.PreToolUse[0]).toEqual(userHook);
    const ours = settings.hooks.Stop[0].hooks[0];
    expect(ours.command).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(ours.command.replace(/\\/g, '/')).toContain('/.auto-claude/flow/hook.cjs');

    // The other project is untouched
    expect(await isLiveAgentEnabled(projectB)).toBe(false);
  });

  it('switching on twice registers the hooks once', async () => {
    await setLiveAgentEnabled(projectA, true);
    await setLiveAgentEnabled(projectA, true);
    for (const event of HOOK_EVENTS) expect(readSettings(projectA).hooks[event]).toHaveLength(1);
  });

  it('switching off deletes a settings file that only held our hooks, and drops the project graphs', async () => {
    await setLiveAgentEnabled(projectA, true);
    await setLiveAgentEnabled(projectA, false);
    expect(fs.existsSync(settingsFile(projectA))).toBe(false);
    expect(fs.existsSync(flowDir(projectA))).toBe(false);
    expect(dropProject).toHaveBeenCalledWith(flowDir(projectA));
  });

  it('switching off removes the hooks and the flow directory, keeping the user hooks', async () => {
    fs.mkdirSync(path.dirname(settingsFile(projectA)));
    const userHook = { hooks: [{ type: 'command', command: 'echo mine' }] };
    fs.writeFileSync(settingsFile(projectA), JSON.stringify({ hooks: { Stop: [userHook] } }));
    await setLiveAgentEnabled(projectA, true);

    await setLiveAgentEnabled(projectA, false);
    expect(fs.existsSync(flowDir(projectA))).toBe(false);
    expect(await isLiveAgentEnabled(projectA)).toBe(false);
    expect(readSettings(projectA)).toEqual({ hooks: { Stop: [userHook] } });
    // No project has it on any more: the relay stops
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('keeps the relay running while another project has Live agent on', async () => {
    await setLiveAgentEnabled(projectA, true);
    await setLiveAgentEnabled(projectB, true);
    setEnabled.mockClear();
    await setLiveAgentEnabled(projectA, false);
    expect(setEnabled).not.toHaveBeenCalledWith(false);
  });

  it('leaves settings it cannot parse alone, and still switches on', async () => {
    fs.mkdirSync(path.dirname(settingsFile(projectA)));
    fs.writeFileSync(settingsFile(projectA), '{ not json');

    const result = await setLiveAgentEnabled(projectA, true);
    expect(result.hooksError).toContain('left untouched');
    expect(fs.readFileSync(settingsFile(projectA), 'utf-8')).toBe('{ not json');
    expect(await isLiveAgentEnabled(projectA)).toBe(true);
  });

  it('starts the relay at startup only when a project has Live agent on', async () => {
    await syncLiveAgentAtStartup();
    expect(setEnabled).not.toHaveBeenCalled();

    fs.mkdirSync(flowDir(projectB), { recursive: true });
    await syncLiveAgentAtStartup();
    expect(setEnabled).toHaveBeenCalledWith(true);
    // The setup is refreshed for it
    expect(fs.existsSync(path.join(flowDir(projectB), 'hook.cjs'))).toBe(true);
  });

  it('the installed hook script forwards a hook event to the relay advertised in the flow directory', async () => {
    await setLiveAgentEnabled(projectA, true);
    const received = new Promise<string>((resolve) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => { res.end(); server.close(); resolve(body); });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        fs.writeFileSync(path.join(flowDir(projectA), `test-${process.pid}.json`),
          JSON.stringify({ port, pid: process.pid, workspace: projectA }));
        const hook = spawn(process.execPath, [path.join(flowDir(projectA), 'hook.cjs')], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        hook.stdin.end(JSON.stringify({ cwd: projectA, session_id: 's1', hook_event_name: 'Stop' }));
      });
    });
    expect(JSON.parse(await received)).toMatchObject({ session_id: 's1', hook_event_name: 'Stop' });
  });

  describe('worktrees', () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
    const worktree = (name: string) => path.join(projectA, '.auto-claude', 'worktrees', name);

    beforeEach(() => {
      git(projectA, 'init', '-q');
      git(projectA, 'commit', '-q', '--allow-empty', '-m', 'init');
      git(projectA, 'worktree', 'add', '-q', '--detach', worktree('existing'));
      fs.mkdirSync(path.dirname(settingsFile(projectA)));
      fs.writeFileSync(settingsFile(projectA), JSON.stringify({ model: 'opus' }));
    });

    it('switching on copies the project settings, hooks included, into existing worktrees', async () => {
      await setLiveAgentEnabled(projectA, true);
      const copy = readSettings(worktree('existing'));
      expect(copy.model).toBe('opus');
      expect(copy.hooks).toEqual(readSettings(projectA).hooks);
    });

    it('a worktree created later gets the copy, and nothing while Live agent is off', async () => {
      git(projectA, 'worktree', 'add', '-q', '--detach', worktree('off'));
      addToWorktree(projectA, worktree('off'));
      expect(fs.existsSync(settingsFile(worktree('off')))).toBe(false);

      await setLiveAgentEnabled(projectA, true);
      git(projectA, 'worktree', 'add', '-q', '--detach', worktree('later'));
      addToWorktree(projectA, worktree('later'));
      expect(readSettings(worktree('later')).hooks).toEqual(readSettings(projectA).hooks);
    });

    it('adds the hooks to a worktree that has its own settings, keeping them', async () => {
      fs.mkdirSync(path.join(worktree('existing'), '.claude'));
      fs.writeFileSync(settingsFile(worktree('existing')), JSON.stringify({ env: { A: '1' } }));
      await setLiveAgentEnabled(projectA, true);
      const settings = readSettings(worktree('existing'));
      expect(settings.env).toEqual({ A: '1' });
      expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    });

    it('switching off removes the hooks from the worktrees too', async () => {
      await setLiveAgentEnabled(projectA, true);
      await setLiveAgentEnabled(projectA, false);
      expect(readSettings(worktree('existing'))).toEqual({ model: 'opus' });
      expect(readSettings(projectA)).toEqual({ model: 'opus' });
      expect(fs.existsSync(flowDir(projectA))).toBe(false);
    });
  });
});
