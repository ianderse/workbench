/**
 * The relay (agent-flow's, run in the Live agent worker): a client gets the sessions run in its
 * own directory and nothing from other directories, and the relay advertises itself in the
 * project's .workbench/flow directory
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelay, type Relay } from '../relay/relay';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

describe('relay', () => {
  let root: string;
  let workspace: string;
  let otherDir: string;
  let flowDir: string;
  let transcript: string;
  let relay: Relay;
  const sent: Array<{ clientIds: string[]; message: { type: string; [key: string]: unknown } }> = [];
  /** Discovery files this relay wrote in the project's flow directory */
  const discoveryFiles = () =>
    (fs.existsSync(flowDir) ? fs.readdirSync(flowDir) : []).filter((file) => file.endsWith(`-${process.pid}.json`));

  beforeEach(async () => {
    sent.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-relay-')));
    workspace = path.join(root, 'project');
    otherDir = path.join(root, 'other');
    flowDir = path.join(workspace, '.workbench', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.mkdirSync(otherDir);
    const claudeDir = path.join(root, 'claude-config');
    const projectDir = path.join(claudeDir, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const line = { type: 'user', uuid: 'u1', cwd: workspace, message: { role: 'user', content: 'Hello' } };
    transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, JSON.stringify(line) + '\n');

    relay = await createRelay({
      claudeDirs: [claudeDir],
      send: (clientIds, data) => sent.push({ clientIds, message: JSON.parse(data) }),
    });
  });

  afterEach(() => {
    relay.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sends a client the sessions run in its directory', () => {
    relay.subscribe('window-a', workspace, flowDir);

    const forA = sent.filter((entry) => entry.clientIds.includes('window-a')).map((entry) => entry.message);
    expect(forA.some((message) => message.type === 'session-started')).toBe(true);
    const batch = forA.find((message) => message.type === 'agent-event-batch');
    expect(batch).toMatchObject({ sessionId: SESSION_ID });

    // Advertised to the project's hook script, next to it in the flow directory
    expect(discoveryFiles()).toHaveLength(1);
    const discovery = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    expect(discovery).toMatchObject({ pid: process.pid, workspace });
  });

  it('sends a client nothing from sessions run elsewhere', () => {
    relay.subscribe('window-b', otherDir, flowDir);
    relay.subscribe('window-a', workspace, flowDir);

    expect(sent.some((entry) => entry.clientIds.includes('window-b'))).toBe(false);
  });

  it('replays the history to a client that subscribes later', () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    relay.subscribe('window-c', workspace, flowDir);

    const forC = sent.filter((entry) => entry.clientIds.includes('window-c')).map((entry) => entry.message.type);
    expect(forC).toEqual(['session-list', 'agent-event-batch']);
  });

  it('tells clients which agent window a session runs in, as its hooks report it', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: SESSION_ID, hook_event_name: 'UserPromptSubmit', cwd: workspace, workbench_terminal_id: 'terminal-1',
      }),
    });

    const owners = sent.filter((entry) => entry.message.type === 'session-owner');
    expect(owners).toEqual([{ clientIds: ['window-a'], message: { type: 'session-owner', sessionId: SESSION_ID, owner: 'terminal-1' } }]);

    // A client that subscribes later learns it from the session list
    sent.length = 0;
    relay.subscribe('window-c', workspace, flowDir);
    const list = sent.find((entry) => entry.message.type === 'session-list');
    expect(list?.message.sessions).toEqual([expect.objectContaining({ id: SESSION_ID, owner: 'terminal-1' })]);
  });

  it('gives no node to a sub-agent handing its report back (SubagentHandback)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    sent.length = 0;
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    const preToolUse = (tool: string, id: string) => fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'PreToolUse', cwd: workspace, tool_name: tool, tool_use_id: id }),
    });
    await preToolUse('SubagentHandback', 'toolu_handback');
    await preToolUse('Read', 'toolu_read');

    const started = sent
      .filter((entry) => entry.message.type === 'agent-event')
      .map((entry) => entry.message.event as { type: string; payload: { tool?: string } })
      .filter((event) => event.type === 'tool_call_start')
      .map((event) => event.payload.tool);
    expect(started).toEqual(['Read']);
  });

  /** Append transcript lines, have a hook read them, and return the agent events sent meanwhile */
  async function appendAndRead(lines: object[]): Promise<string[]> {
    fs.appendFileSync(transcript, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    sent.length = 0;
    // A hook reads the transcript's new lines first (one the hook server passes
    // on, so this doesn't wait for fs.watch, which is slow on macOS)
    const { port } = JSON.parse(fs.readFileSync(path.join(flowDir, discoveryFiles()[0]), 'utf-8'));
    await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'Notification', notification_type: 'permission_prompt', cwd: workspace }),
    });
    return sent
      .filter((entry) => entry.message.type === 'agent-event')
      .map((entry) => (entry.message.event as { type: string }).type)
      .filter((type) => type !== 'permission_requested');
  }

  const reply = { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'The sleeper finished.' }] } };
  const turnEnd = { type: 'system', subtype: 'turn_duration' };
  const notification = {
    type: 'user', uuid: 'n1',
    message: { role: 'user', content: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n</task-notification>' },
  };

  it('keeps the main agent done when a handed-back sub-agent\'s notification arrives after its turn (2.1.300+)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    // The sub-agent's report (SubagentHandback) starts a turn, which ends; the
    // <task-notification> is written afterwards, and nothing answers it
    const handback = {
      type: 'user', uuid: 'p1', isMeta: true,
      origin: { kind: 'peer', from: 'task-1', senderTaskId: 'task-1', handback: true },
      message: { role: 'user', content: 'Another Claude session sent a message: slept 1s' },
    };
    expect(await appendAndRead([handback, reply, turnEnd, notification])).toEqual(['message', 'agent_complete']);
  });

  it('wakes the main agent for a task notification it answers (before 2.1.300)', async () => {
    relay.subscribe('window-a', workspace, flowDir);
    await appendAndRead([reply, turnEnd]);
    // The notification itself starts the turn in which the agent replies
    expect(await appendAndRead([notification])).toEqual(['message']);
  });

  it('writes no discovery file for a project with Live agent off', () => {
    fs.rmSync(flowDir, { recursive: true });
    relay.subscribe('window-a', workspace, flowDir);
    expect(fs.existsSync(flowDir)).toBe(false);
  });

  it('stops advertising a directory once no client shows it', () => {
    relay.subscribe('window-a', workspace, flowDir);
    relay.subscribe('window-c', workspace, flowDir);
    relay.unsubscribe('window-a');
    expect(discoveryFiles()).toHaveLength(1);
    relay.unsubscribe('window-c');
    expect(discoveryFiles()).toEqual([]);
  });

  it('dispose removes the discovery file', () => {
    relay.subscribe('window-a', workspace, flowDir);
    relay.dispose();
    expect(discoveryFiles()).toEqual([]);
  });
});
