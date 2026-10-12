import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { SessionFollower } from '../session-follower';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const waitFor = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 2000, interval: 10 });

describe('SessionFollower', () => {
  let configDir: string;
  let transcript: string;
  let output: string;
  let running: boolean;
  let follower: SessionFollower | null;
  const onContinue = vi.fn();
  const onRelease = vi.fn();

  beforeEach(() => {
    configDir = mkdtempSync(path.join(os.tmpdir(), 'follower-'));
    const projectDir = path.join(configDir, 'projects', '-work-tree');
    mkdirSync(projectDir, { recursive: true });
    transcript = path.join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcript, '');
    output = '';
    running = true;
    onContinue.mockReset();
    onRelease.mockReset();
    follower = new SessionFollower({
      sessionId: SESSION_ID,
      configDir,
      cwd: '/work/tree',
      run: { isRunning: () => running, getSession: () => ({ sessionId: SESSION_ID, configDir }) },
      write: (data) => {
        output += data;
      },
      onContinue,
      onRelease,
      pollMs: 20,
    });
  });

  afterEach(() => {
    follower?.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('prints assistant text, tool calls and their results as the transcript grows', async () => {
    follower!.start();
    appendFileSync(
      transcript,
      line({ type: 'user', message: { content: [{ type: 'text', text: '<task>Fix the bug</task>' }] } }) +
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the handler' }] } }) +
        line({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/tree/src/a.ts' } }] },
        }) +
        line({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'line one\nline two' }] },
        }) +
        line({ type: 'attachment' })
    );
    await waitFor(() => stripAnsi(output).includes('line one'));
    const text = stripAnsi(output);
    expect(text).toContain('› <task>Fix the bug</task>');
    expect(text).toContain('● Looking at the handler');
    expect(text).toContain(`● Read(${path.join('src', 'a.ts')})`);
    expect(text).toContain('⎿  line one (+1 lines)');
  });

  it('ignores keys while the task runs, then continues the session on Enter once it stops', async () => {
    follower!.start();
    follower!.handleInput('\r');
    expect(onContinue).not.toHaveBeenCalled();

    running = false;
    await waitFor(() => stripAnsi(output).includes('The task stopped'));
    follower!.handleInput('\r');
    expect(onContinue).toHaveBeenCalledWith({ sessionId: SESSION_ID, configDir, profileId: undefined });
  });

  it('stops following on Ctrl+C', () => {
    follower!.start();
    follower!.handleInput('\x03');
    expect(onRelease).toHaveBeenCalled();
    expect(stripAnsi(output)).toContain('Stopped following the session.');
  });
});
