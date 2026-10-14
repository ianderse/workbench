/**
 * The relay (agent-flow's, run in the Live agent worker): a client gets the sessions run in its
 * own directory and nothing from other directories, and the relay advertises itself in the
 * project's .auto-claude/flow directory
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
    flowDir = path.join(workspace, '.auto-claude', 'flow');
    fs.mkdirSync(flowDir, { recursive: true });
    fs.mkdirSync(otherDir);
    const claudeDir = path.join(root, 'claude-config');
    const projectDir = path.join(claudeDir, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const line = { type: 'user', uuid: 'u1', cwd: workspace, message: { role: 'user', content: 'Hello' } };
    fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), JSON.stringify(line) + '\n');

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
