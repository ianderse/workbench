/**
 * The store of Claude Code sessions a project's agent windows started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { cacheAgentSessionSpending, readAgentSessions, recordAgentSession } from '../agent-session-store';

vi.mock('../app-logger', () => ({ appLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

describe('agent session store', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-'));
    mkdirSync(path.join(project, '.workbench'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  const storeFile = () => path.join(project, '.workbench', 'agent-sessions.json');
  const session = (sessionId: string, startedAt = '2026-10-21T09:00:00.000Z') => ({ sessionId, startedAt });

  it('has no sessions for a project whose windows never ran Claude Code', async () => {
    expect(await readAgentSessions(project)).toEqual([]);
  });

  it('keeps the sessions windows started, oldest first', async () => {
    await recordAgentSession(project, session('one', '2026-10-20T09:00:00.000Z'));
    await recordAgentSession(project, {
      ...session('two'),
      terminalId: 'b',
      configDir: '/home/user/.claude-profiles/work',
      cwd: '/home/user/project',
    });

    const sessions = await readAgentSessions(project);
    expect(sessions.map((kept) => kept.sessionId)).toEqual(['one', 'two']);
    expect(sessions[1].configDir).toBe('/home/user/.claude-profiles/work');
    expect(sessions[1].cwd).toBe('/home/user/project');
  });

  it('keeps a session it already knows once, with what it spent', async () => {
    await recordAgentSession(project, session('one', '2026-10-20T09:00:00.000Z'));
    await cacheAgentSessionSpending(
      project,
      new Map([['one', { totalCostUsd: 0.5, days: { '2026-10-20': 0.5 }, transcript: '/t.jsonl', size: 10, modifiedMs: 1 }]])
    );
    await recordAgentSession(project, session('one', '2026-10-21T09:00:00.000Z'));

    const sessions = await readAgentSessions(project);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].startedAt).toBe('2026-10-21T09:00:00.000Z');
    // Restarting the session must not throw away what it had already spent
    expect(sessions[0].spent?.totalCostUsd).toBe(0.5);
  });

  it('loses no session when several windows start at once', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => recordAgentSession(project, session(id))));

    expect((await readAgentSessions(project)).map((kept) => kept.sessionId).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never drops old sessions, whose spending is counted on every refresh', async () => {
    for (let index = 0; index < 600; index++) await recordAgentSession(project, session(`s${index}`));

    const sessions = await readAgentSessions(project);
    expect(sessions).toHaveLength(600);
    expect(sessions[0].sessionId).toBe('s0');
  });

  it('leaves a store file it cannot make sense of alone, rather than writing over the history', async () => {
    writeFileSync(storeFile(), '{ not json');

    expect(await readAgentSessions(project)).toEqual([]);

    await recordAgentSession(project, session('one'));

    expect(readFileSync(storeFile(), 'utf-8')).toBe('{ not json');
  });

  it('writes nothing in a project that has no .workbench directory', async () => {
    rmSync(path.join(project, '.workbench'), { recursive: true });

    await recordAgentSession(project, session('one'));

    expect(existsSync(path.join(project, '.workbench'))).toBe(false);
  });

  it('leaves no temp file behind', async () => {
    await recordAgentSession(project, session('one'));

    expect(readdirSync(path.join(project, '.workbench'))).toEqual(['agent-sessions.json']);
  });
});
