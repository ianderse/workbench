/**
 * The relay (agent-flow's, run in the Live agent worker): a client gets the sessions run in its
 * own directory and nothing from other directories
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpHome } = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { tmpHome: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'live-agent-home-')) };
});

// The relay writes agent-flow's discovery files under ~/.claude/agent-flow
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => tmpHome };
  return { ...mocked, default: mocked };
});

import { createRelay, type Relay } from '../relay/relay';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

describe('relay', () => {
  let workspace: string;
  let otherDir: string;
  let claudeDir: string;
  let relay: Relay;
  const sent: Array<{ clientIds: string[]; message: { type: string; [key: string]: unknown } }> = [];

  beforeEach(async () => {
    sent.length = 0;
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-ws-')));
    otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-agent-other-')));
    claudeDir = path.join(tmpHome, 'claude-config');
    const projectDir = path.join(claudeDir, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const line = { type: 'user', uuid: 'u1', cwd: workspace, message: { role: 'user', content: 'Hello' } };
    fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), JSON.stringify(line) + '\n');

    relay = await createRelay({
      claudeDirs: [claudeDir],
      send: (clientIds, data) => sent.push({ clientIds, message: JSON.parse(data) }),
    });
  });

  afterAll(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    relay.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it('sends a client the sessions run in its directory', () => {
    relay.subscribe('window-a', workspace);

    const forA = sent.filter((entry) => entry.clientIds.includes('window-a')).map((entry) => entry.message);
    expect(forA.some((message) => message.type === 'session-started')).toBe(true);
    const batch = forA.find((message) => message.type === 'agent-event-batch');
    expect(batch).toMatchObject({ sessionId: SESSION_ID });

    // Advertised to agent-flow's hook script for that directory
    const discovery = fs.readdirSync(path.join(tmpHome, '.claude', 'agent-flow'));
    expect(discovery.some((file) => file.endsWith(`-${process.pid}.json`))).toBe(true);
  });

  it('sends a client nothing from sessions run elsewhere', () => {
    relay.subscribe('window-b', otherDir);
    relay.subscribe('window-a', workspace);

    expect(sent.some((entry) => entry.clientIds.includes('window-b'))).toBe(false);
  });

  it('replays the history to a client that subscribes later', () => {
    relay.subscribe('window-a', workspace);
    sent.length = 0;
    relay.subscribe('window-c', workspace);

    const forC = sent.filter((entry) => entry.clientIds.includes('window-c')).map((entry) => entry.message.type);
    expect(forC).toEqual(['session-list', 'agent-event-batch']);
  });

  it('stops advertising a directory once no client shows it', () => {
    relay.subscribe('window-a', workspace);
    relay.subscribe('window-c', workspace);
    const discoveryDir = path.join(tmpHome, '.claude', 'agent-flow');
    const ours = () => fs.readdirSync(discoveryDir).filter((file) => file.endsWith(`-${process.pid}.json`));
    relay.unsubscribe('window-a');
    expect(ours()).toHaveLength(1);
    relay.unsubscribe('window-c');
    expect(ours()).toEqual([]);
  });

  it('dispose removes the discovery file', () => {
    relay.subscribe('window-a', workspace);
    relay.dispose();
    const discoveryDir = path.join(tmpHome, '.claude', 'agent-flow');
    const left = fs.existsSync(discoveryDir) ? fs.readdirSync(discoveryDir) : [];
    expect(left.filter((file) => file.endsWith(`-${process.pid}.json`))).toEqual([]);
  });
});
