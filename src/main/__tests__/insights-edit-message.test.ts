import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = vi.fn();

vi.mock('../insights/insights-executor', async () => {
  const { EventEmitter } = await import('events');
  class FakeExecutor extends EventEmitter {
    cancelSession() { return false; }
    execute(...args: unknown[]) { return execute(...args); }
  }
  return { InsightsExecutor: FakeExecutor };
});
vi.mock('../insights/config', () => ({ InsightsConfig: class { configure() {} } }));

import { insightsService as service } from '../insights-service';

let projectDir: string;
let pid: string;
let run = 0;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'insights-edit-'));
  pid = `project-${++run}`;
  execute.mockReset();
});
afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

function answer(text: string) {
  execute.mockResolvedValueOnce({ fullResponse: text, toolsUsed: [] });
}

describe('InsightsService.editMessage', () => {
  it('drops the chat after the edited message and sends the edit', async () => {
    answer('First reply');
    await service.sendMessage(pid, projectDir, 'first question');
    answer('Second reply');
    await service.sendMessage(pid, projectDir, 'second question');
    const firstId = service.loadSession(pid, projectDir)!.messages[0].id;

    answer('Reply to the edit');
    await service.editMessage(pid, projectDir, firstId, 'edited question');

    const session = service.loadSession(pid, projectDir)!;
    expect(session.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'edited question'],
      ['assistant', 'Reply to the edit'],
    ]);
    // The edited first message names the conversation now
    expect(session.title).toBe('edited question');
    // Claude gets the edited message, without the dropped turns (nothing came before it); the
    // message itself is sent on its own, not repeated in the history
    const [, , message, history] = execute.mock.calls.at(-1)!;
    expect(message).toBe('edited question');
    expect(history).toEqual([]);
  });

  it('keeps a title the user gave', async () => {
    answer('Reply');
    await service.sendMessage(pid, projectDir, 'question');
    const session = service.loadSession(pid, projectDir)!;
    service.renameSession(projectDir, session.id, 'My chat');
    session.title = 'My chat';

    answer('Reply to the edit');
    await service.editMessage(pid, projectDir, session.messages[0].id, 'edited');

    expect(service.loadSession(pid, projectDir)!.title).toBe('My chat');
  });

  it('ignores an unknown message', async () => {
    answer('Reply');
    await service.sendMessage(pid, projectDir, 'question');

    await service.editMessage(pid, projectDir, 'msg-missing', 'edited');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.loadSession(pid, projectDir)!.messages).toHaveLength(2);
  });
});

describe('Claude Code sessions of a chat', () => {
  let turn = 0;
  /** A reply that ended at a new point of session `sessionId` */
  function answerIn(sessionId: string, text = 'Reply') {
    turn += 1;
    execute.mockResolvedValueOnce({ fullResponse: text, toolsUsed: [], claudeRef: { sessionId, messageUuid: `uuid-${turn}`, profileId: 'main' } });
  }
  const planOf = (call: number) => (execute.mock.calls[call][6] as { session: unknown }).session;

  it('starts a session, resumes it, and forks it where an edit cuts the chat', async () => {
    answerIn('s1');
    await service.sendMessage(pid, projectDir, 'first');
    answerIn('s1');
    await service.sendMessage(pid, projectDir, 'second');
    answerIn('s1');
    await service.sendMessage(pid, projectDir, 'third');

    expect(planOf(0)).toEqual({ mode: 'new' });
    expect(planOf(1)).toEqual({ mode: 'resume', sessionId: 's1', profileId: 'main' });
    expect(planOf(2)).toEqual({ mode: 'resume', sessionId: 's1', profileId: 'main' });

    // Editing the second message keeps the first reply: the session is forked there
    const messages = service.loadSession(pid, projectDir)!.messages;
    const firstReply = messages[1];
    answerIn('s2');
    await service.editMessage(pid, projectDir, messages[2].id, 'second, edited');
    expect(planOf(3)).toEqual({ mode: 'fork', sessionId: 's1', atMessageUuid: firstReply.claudeRef!.messageUuid, profileId: 'main' });

    // The fork is the chat's session from then on
    answerIn('s2');
    await service.sendMessage(pid, projectDir, 'fourth');
    expect(planOf(4)).toEqual({ mode: 'resume', sessionId: 's2', profileId: 'main' });
  });

  it('forks at the reply before the one being regenerated', async () => {
    answerIn('s1');
    await service.sendMessage(pid, projectDir, 'first');
    answerIn('s1');
    await service.sendMessage(pid, projectDir, 'second');
    const firstReply = service.loadSession(pid, projectDir)!.messages[1];

    answerIn('s3');
    await service.regenerate(pid, projectDir);
    expect(planOf(2)).toEqual({ mode: 'fork', sessionId: 's1', atMessageUuid: firstReply.claudeRef!.messageUuid, profileId: 'main' });
  });

  it('starts anew after editing the first message or after a stopped reply', async () => {
    answerIn('s1');
    await service.sendMessage(pid, projectDir, 'first');
    const first = service.loadSession(pid, projectDir)!.messages[0];
    answerIn('s4');
    await service.editMessage(pid, projectDir, first.id, 'first, edited');
    expect(planOf(1)).toEqual({ mode: 'new' });

    execute.mockResolvedValueOnce({ fullResponse: 'Part', toolsUsed: [], stopped: true, claudeRef: { sessionId: 's4', messageUuid: 'x' } });
    await service.sendMessage(pid, projectDir, 'stopped one');
    answerIn('s5');
    await service.sendMessage(pid, projectDir, 'after the stop');
    expect(planOf(3)).toEqual({ mode: 'new' });
  });
});
