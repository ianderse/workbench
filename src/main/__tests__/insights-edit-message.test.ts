import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = vi.fn();
const cancel = vi.fn((_projectId: string) => false);

vi.mock('../insights/insights-executor', async () => {
  const { EventEmitter } = await import('events');
  class FakeExecutor extends EventEmitter {
    cancelSession(projectId: string) { return cancel(projectId); }
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
  cancel.mockReset();
  cancel.mockReturnValue(false);
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

  it('ignores an unknown message, and tells the chat so it stops waiting', async () => {
    answer('Reply');
    await service.sendMessage(pid, projectDir, 'question');
    const errors: string[] = [];
    const onError = (id: string, error: string) => { if (id === pid) errors.push(error); };
    service.on('error', onError);

    await service.editMessage(pid, projectDir, 'msg-missing', 'edited');
    service.off('error', onError);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.loadSession(pid, projectDir)!.messages).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('gives each message its own id, even within the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      answer('Reply');
      await service.sendMessage(pid, projectDir, 'question');
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    const [question, reply] = service.loadSession(pid, projectDir)!.messages;
    expect(question.id).not.toBe(reply.id);
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

describe('a reply running when the user leaves its chat', () => {
  /** The next reply runs until it is stopped, then ends as a stopped reply with what it wrote */
  function answerUntilStopped(text = 'Partial') {
    execute.mockImplementationOnce(() => new Promise((resolve) => {
      cancel.mockImplementationOnce(() => {
        resolve({ fullResponse: text, toolsUsed: [], stopped: true });
        return true;
      });
    }));
  }
  function sessionUpdates() {
    const ids: string[] = [];
    const listener = (id: string, session: { id: string }) => { if (id === pid) ids.push(session.id); };
    service.on('session-updated', listener);
    return { ids, stop: () => service.off('session-updated', listener) };
  }

  it('stops when a new chat opens and stays in its own chat', async () => {
    answerUntilStopped();
    const sending = service.sendMessage(pid, projectDir, 'first');
    const chatId = service.loadSession(pid, projectDir)!.id;

    service.startNewChat(pid, projectDir);
    await sending;

    expect(cancel).toHaveBeenCalled();
    // The new chat stays empty; the stopped reply is kept in the chat it belongs to
    expect(service.loadSession(pid, projectDir)).toBeNull();
    const chat = service.switchSession(pid, projectDir, chatId)!;
    expect(chat.messages.map((m) => [m.role, m.content, m.stopped])).toEqual([
      ['user', 'first', undefined],
      ['assistant', 'Partial', true],
    ]);
  });

  it('stops when its chat is deleted, and the chat stays deleted', async () => {
    answerUntilStopped();
    const sending = service.sendMessage(pid, projectDir, 'first');
    const chatId = service.loadSession(pid, projectDir)!.id;
    const updates = sessionUpdates();

    service.deleteSession(pid, projectDir, chatId);
    await sending;
    updates.stop();

    expect(cancel).toHaveBeenCalled();
    expect(updates.ids).toEqual([]);
    expect(service.listSessions(projectDir, true)).toEqual([]);
    expect(service.loadSession(pid, projectDir)).toBeNull();
  });

  it('stops when the user switches to another chat, which stays the open one', async () => {
    answer('Other reply');
    await service.sendMessage(pid, projectDir, 'other chat');
    const otherId = service.loadSession(pid, projectDir)!.id;
    service.startNewChat(pid, projectDir);

    answerUntilStopped();
    const sending = service.sendMessage(pid, projectDir, 'first');
    const chatId = service.loadSession(pid, projectDir)!.id;
    expect(chatId).not.toBe(otherId);

    service.switchSession(pid, projectDir, otherId);
    await sending;

    expect(cancel).toHaveBeenCalled();
    expect(service.loadSession(pid, projectDir)!.id).toBe(otherId);
    expect(service.loadSession(pid, projectDir)!.messages).toHaveLength(2);
    expect(service.switchSession(pid, projectDir, chatId)!.messages.at(-1)).toMatchObject({ content: 'Partial', stopped: true });
  });

  it('keeps running when another chat is deleted or its own chat is opened again', async () => {
    answer('Other reply');
    await service.sendMessage(pid, projectDir, 'other chat');
    const otherId = service.loadSession(pid, projectDir)!.id;
    service.startNewChat(pid, projectDir);

    answerUntilStopped();
    const sending = service.sendMessage(pid, projectDir, 'first');
    const chatId = service.loadSession(pid, projectDir)!.id;
    cancel.mockClear();

    service.deleteSession(pid, projectDir, otherId);
    service.switchSession(pid, projectDir, chatId);
    expect(cancel).not.toHaveBeenCalled();

    service.stopMessage(pid);
    await sending;
  });

  it('regenerates in the chat shown, not in the one open before', async () => {
    answer('Reply A');
    await service.sendMessage(pid, projectDir, 'question A');
    const chatA = service.loadSession(pid, projectDir)!.id;
    service.startNewChat(pid, projectDir);
    answer('Reply B');
    await service.sendMessage(pid, projectDir, 'question B');

    answer('Reply A, again');
    await service.regenerate(pid, projectDir, undefined, chatA);

    const [, , message] = execute.mock.calls.at(-1)!;
    expect(message).toBe('question A');
    const session = service.loadSession(pid, projectDir)!;
    expect(session.id).toBe(chatA);
    expect(session.messages.map((m) => m.content)).toEqual(['question A', 'Reply A, again']);
  });
});
